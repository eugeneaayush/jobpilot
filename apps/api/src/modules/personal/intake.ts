import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ResumeData, resumeDataSchema } from "@jobpilot/contracts/resume";

interface SourceRecord {
  path: string;
  sha256: string;
  bytes: number;
  frozenPath: string;
}
interface SourceLeaf {
  pointer: string;
  value: unknown;
  docxParagraphs: number[];
}
interface IntakeConflict {
  kind: string;
  source: string;
  pointer?: string;
  message: string;
  values: unknown[];
}
export interface IntakeOptions {
  comparisonPaths?: string[];
  assertions?: { label: string; pattern: string; expected: string; source: string }[];
}
export interface IntakeResult {
  data: ResumeData;
  manifest: {
    version: 1;
    sources: SourceRecord[];
    leaves: SourceLeaf[];
    paragraphs: { index: number; reference: string; text: string }[];
    conflicts: IntakeConflict[];
    unmapped: string[];
    importedAt: string;
  };
  manifestPath: string;
}
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
function flatten(value: unknown, pointer = ""): { pointer: string; value: unknown }[] {
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, child]) =>
      flatten(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
    );
  return [{ pointer, value }];
}
function normalizePhone(value: unknown): string | undefined {
  const phone = string(value);
  if (!phone) return undefined;
  if (phone.startsWith("+")) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10 && /^\(\d{3}\)\s*\d{3}[- ]\d{4}$/.test(phone)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
}
function mapMaster(raw: Record<string, unknown>): { data: ResumeData; unmapped: string[] } {
  if (raw.basics) {
    const data = resumeDataSchema.parse(raw);
    const kept = new Set(flatten(data).map((leaf) => leaf.pointer));
    return {
      data,
      unmapped: flatten(raw)
        .filter((leaf) => !kept.has(leaf.pointer))
        .map((leaf) => leaf.pointer),
    };
  }
  const contact = object(raw.contact);
  const additional = array(object(raw.additional).lines);
  const data = resumeDataSchema.parse({
    basics: {
      name: raw.name,
      email: contact.email,
      phone: normalizePhone(contact.phone),
      location: contact.city,
      linkedin: contact.linkedin || undefined,
    },
    education: array(raw.education).map((entry, index) => ({
      id: `education-${index}`,
      school: entry.institution,
      degree: entry.detail || entry.degree,
      start: string(entry.dates) || undefined,
      details: [string(entry.location), ...strings(entry.bullets)].filter(Boolean),
    })),
    experience: array(raw.experience).map((entry, index) => ({
      id: `experience-${index}`,
      company: entry.company,
      title: entry.title,
      location: entry.location,
      start: string(entry.dates) || string(entry.start_date),
      end: entry.dates
        ? undefined
        : string(entry.end_date) || (entry.present === true ? "Present" : undefined),
      bullets: strings(entry.bullets),
    })),
    projects: raw.projects,
    skills: raw.skills,
    publications: raw.publications,
    awards: raw.awards,
    certifications: raw.certifications,
    sections: [
      ...array(raw.sections),
      ...(additional.length
        ? [
            {
              title: "Additional Information",
              entries: additional.map((line) => ({
                heading: line.label,
                bullets: [string(line.text)],
              })),
            },
          ]
        : []),
    ],
  });
  const known = new Set([
    "name",
    "contact",
    "education",
    "experience",
    "additional",
    "projects",
    "skills",
    "publications",
    "awards",
    "certifications",
    "sections",
  ]);
  const metadata = new Set(["_notes", "certified_figures", "layout"]);
  const unmapped = flatten(raw)
    .filter((leaf) => !known.has(leaf.pointer.split("/")[1] ?? ""))
    .map((leaf) => leaf.pointer);
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key) || metadata.has(key)) continue;
    data.sections.push({
      title: key,
      entries: [
        {
          heading: key,
          bullets: flatten(value).map(
            (leaf) =>
              `${leaf.pointer || key}: ${typeof leaf.value === "string" ? leaf.value : JSON.stringify(leaf.value)}`,
          ),
        },
      ],
    });
  }
  return { data, unmapped };
}

export async function intakeMaster(
  sourceJsonPath: string,
  sourceDocxPath: string,
  runtimeDir: string,
  options: IntakeOptions = {},
): Promise<IntakeResult> {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  const sourceDir = join(runtimeDir, "sources");
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  await chmod(sourceDir, 0o700);
  const sources: SourceRecord[] = [];
  async function freeze(path: string): Promise<Buffer> {
    const bytes = await readFile(path);
    const sha256 = digest(bytes);
    const frozenPath = join(sourceDir, `${sha256}-${basename(path)}`);
    await writeFile(frozenPath, bytes, { mode: 0o600 });
    await chmod(frozenPath, 0o600);
    sources.push({ path, sha256, bytes: bytes.length, frozenPath });
    return bytes;
  }
  const json = await freeze(sourceJsonPath);
  await freeze(sourceDocxPath);
  const raw = object(JSON.parse(json.toString("utf8")));
  const { data, unmapped } = mapMaster(raw);
  const docxSource = sources[1];
  if (!docxSource) throw new Error("DOCX source missing");
  const process = Bun.spawn(["unzip", "-p", docxSource.frozenPath, "word/document.xml"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const xml = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(`DOCX extraction failed: ${stderr}`);
  const decode = (text: string) =>
    text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((match, index) => ({
    index: index + 1,
    reference: `word/document.xml#paragraph-${index + 1}`,
    text: [...(match[1] ?? "").matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((part) => decode(part[1] ?? ""))
      .join(""),
  }));
  if (!paragraphs.some((paragraph) => paragraph.text))
    throw new Error("DOCX contains no readable paragraphs");
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const leaves = flatten(raw).map((leaf) => ({
    ...leaf,
    docxParagraphs:
      typeof leaf.value === "string" && leaf.value.trim()
        ? paragraphs
            .filter((paragraph) =>
              normalize(paragraph.text).includes(normalize(String(leaf.value))),
            )
            .map((paragraph) => paragraph.index)
        : [],
  }));
  const conflicts: IntakeConflict[] = [];
  const jsonFigures = strings(raw.certified_figures);
  const docxText = paragraphs.map((paragraph) => paragraph.text).join("\n");
  for (const figure of jsonFigures)
    if (!normalize(docxText).includes(normalize(figure)))
      conflicts.push({
        kind: "docx_discrepancy",
        source: sourceDocxPath,
        message: "Certified figure is not corroborated in DOCX; review sources",
        values: [figure],
      });
  for (const path of options.comparisonPaths ?? []) {
    const bytes = await freeze(path);
    try {
      const other = new Map(
        flatten(JSON.parse(bytes.toString("utf8"))).map((leaf) => [leaf.pointer, leaf.value]),
      );
      for (const leaf of leaves)
        if (
          other.has(leaf.pointer) &&
          JSON.stringify(other.get(leaf.pointer)) !== JSON.stringify(leaf.value)
        )
          conflicts.push({
            kind: "source_difference",
            source: path,
            pointer: leaf.pointer,
            message: "Source values disagree; no automatic resolution",
            values: [leaf.value, other.get(leaf.pointer)],
          });
    } catch {
      conflicts.push({
        kind: "context_review",
        source: path,
        message:
          "Supporting prose requires source review; retained verbatim in private source copy",
        values: [],
      });
    }
  }
  for (const assertion of options.assertions ?? []) {
    const matches = [
      ...`${json.toString("utf8")}\n${docxText}`.matchAll(new RegExp(assertion.pattern, "gi")),
    ].map((match) => match[1] ?? match[0]);
    if (!matches.length || matches.some((match) => match !== assertion.expected))
      conflicts.push({
        kind: "assertion_conflict",
        source: assertion.source,
        message: assertion.label,
        values: [assertion.expected, ...new Set(matches)],
      });
  }
  if (unmapped.length)
    conflicts.push({
      kind: "unmapped_fields",
      source: sourceJsonPath,
      message: "Fields retained in manifest require review for document relevance",
      values: unmapped,
    });
  const manifest: IntakeResult["manifest"] = {
    version: 1,
    sources,
    leaves,
    paragraphs,
    conflicts,
    unmapped,
    importedAt: new Date().toISOString(),
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestPath = join(runtimeDir, `intake-${digest(manifestText)}.json`);
  await writeFile(manifestPath, manifestText, { mode: 0o600 });
  return { data, manifest, manifestPath };
}
