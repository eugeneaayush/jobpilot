import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResumeData } from "@jobpilot/contracts/resume";
import { renderToBuffer } from "@react-pdf/renderer";
import { tailorBase } from "../resume/tailor";
import { CbsTemplate } from "./document/cbs-template";
import { assertRendererConfiguration, documentPipelineInputs } from "./local-tools/pipeline-config";
import { assertRendererMapping } from "./local-tools/renderer-mapping";
import { runLocalTool } from "./local-tools/runner";
import { draftDocx } from "./tailoring/docx";
import { applyReviewedProposal, type ReviewedProposal, tailoringHash } from "./tailoring/proposal";
import { applyImportedStructure, localToolSourceHash } from "./yaml.structure";

export interface DocumentOptions {
  jobKeywords?: string[];
  emphasizedTech?: string[];
  conflicts?: unknown[];
  sourceDigest?: string;
  requestedMode?: "extractive" | "rewrite";
  reviewedProposal?: ReviewedProposal;
  maxPages?: 1 | 2;
  renderer?: "cbs-letter-times" | "rendercv-classic";
  userId?: string;
  signal?: AbortSignal;
  documentEdits?: unknown;
}
export interface DocumentManifest {
  path: string;
  sha256: string;
  bytes: number;
  sourceDigest: string | null;
  status: "draft";
  conflicts: unknown[];
  renderQa: "required";
  template: "cbs-letter-times" | "rendercv-classic";
  rendererVersion: string;
  rendererConfigHash: string;
  documentPipelineVersion: string;
  verifierConfigHash: string;
  rendererMapping?: { path: string; sha256: string; bytes: number };
  verifierVersion: "1";
  generatedAt: string;
  data: ResumeData;
  manifestPath: string;
  tailoringMode: "extractive" | "reviewed_rewrite";
  proposalHash: string | null;
  pageCount: number;
  maxPages: 1 | 2;
  pageLimitExceeded: boolean;
  docx:
    | { status: "generated"; path: string; sha256: string; bytes: number; renderQa: "required" }
    | { status: "unavailable"; reason: string };
}

export async function freezeDocumentProvenance(
  directory: string,
  provenance: Omit<DocumentManifest, "manifestPath">,
): Promise<DocumentManifest> {
  // The self-referencing path stays outside the bytes whose hash names this artifact.
  const bytes = JSON.stringify(provenance, null, 2);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(directory, `${hash}.manifest.json`);
  const pendingPath = join(directory, `.${hash}.${crypto.randomUUID()}.pending`);
  try {
    await writeFile(pendingPath, bytes, { mode: 0o600, flag: "wx" });
    // Publish complete bytes atomically without replacing an existing revision.
    await link(pendingPath, manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } finally {
    await rm(pendingPath, { force: true });
  }
  if ((await readFile(manifestPath, "utf8")) !== bytes)
    throw new Error("Frozen document provenance mismatch");
  await chmod(manifestPath, 0o600);
  return { ...provenance, manifestPath };
}

export async function generateDraftPdf(
  data: ResumeData,
  runtimeDir: string,
  options: DocumentOptions = {},
): Promise<DocumentManifest> {
  if (options.requestedMode === "rewrite" && !options.reviewedProposal)
    throw new Error(
      "Requested rewrite requires a grounded proposal; extractive fallback was not substituted",
    );
  if (
    options.reviewedProposal &&
    options.sourceDigest !== options.reviewedProposal.input.sourceDigest
  )
    throw new Error("Proposal source digest differs from frozen document");
  const base = options.reviewedProposal
    ? applyReviewedProposal(data, options.reviewedProposal)
    : data;
  const rewritten =
    options.reviewedProposal !== undefined && tailoringHash(base) !== tailoringHash(data);
  if (options.requestedMode === "rewrite" && !rewritten)
    throw new Error("Requested rewrite produced no reviewed resume changes");
  if (
    options.maxPages &&
    options.reviewedProposal &&
    options.maxPages !== options.reviewedProposal.input.maxPages
  )
    throw new Error("Proposal page budget differs from document request");
  const maxPages = options.maxPages ?? options.reviewedProposal?.input.maxPages ?? 1;
  if (maxPages !== 1 && maxPages !== 2)
    throw new Error("Resume page budget must be one or two pages");
  const maxBullets = Math.max(
    1,
    ...base.experience.map((entry) => entry.bullets.length),
    ...base.projects.map((entry) => entry.bullets.length),
  );
  if (options.documentEdits && !options.reviewedProposal)
    throw new Error("Imported selections require an independently reviewed proposal");
  const tailored =
    options.documentEdits && options.reviewedProposal
      ? applyImportedStructure(data, base, options.documentEdits, options.reviewedProposal)
      : tailorBase(structuredClone(base), {
          jobKeywords: options.jobKeywords,
          emphasizedTech: options.emphasizedTech,
          maxBulletsPerEntry: maxBullets,
        });
  const renderer = options.renderer ?? "cbs-letter-times";
  let bytes: Buffer;
  const pipeline = documentPipelineInputs(renderer);
  let rendererVersion = pipeline.rendererVersion;
  let rendererConfigHash = pipeline.rendererConfigHash;
  let renderedPageCount: number | undefined;
  let mappingBytes: Buffer | undefined;
  if (renderer === "rendercv-classic") {
    if (!options.userId) throw new Error("RenderCV requires a private document owner");
    if (options.conflicts?.length)
      throw new Error("Resolve source conflicts before rendering with RenderCV");
    const output = await runLocalTool(
      options.userId,
      "render_resume",
      { resume: tailored, renderer, maxPages },
      { signal: options.signal },
    );
    assertRendererConfiguration(renderer, output.result);
    if (output.result.sourceSha256 !== localToolSourceHash(tailored))
      throw new Error("Renderer changed its accepted source mapping");
    mappingBytes = output.artifacts[output.result.mappingFilename];
    assertRendererMapping(
      JSON.parse(mappingBytes.toString()),
      tailored,
      output.result.configSha256,
    );
    bytes = output.artifacts[output.result.filename];
    rendererVersion = output.result.rendererVersion;
    rendererConfigHash = output.result.configSha256;
    renderedPageCount = output.result.pageCount;
  } else {
    bytes = await renderToBuffer(
      CbsTemplate({
        data: tailored,
        unresolvedFacts: (options.conflicts?.length ?? 0) > 0,
        maxPages,
      }),
    );
  }
  const pageCount =
    renderedPageCount ?? [...bytes.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
  if (pageCount < 1) throw new Error("PDF page count could not be verified");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = join(runtimeDir, "documents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(directory, 0o700);
  let rendererMapping: DocumentManifest["rendererMapping"];
  if (mappingBytes) {
    const mappingHash = createHash("sha256").update(mappingBytes).digest("hex");
    const mappingPath = join(directory, `${mappingHash}.mapping.json`);
    await writeFile(mappingPath, mappingBytes, { mode: 0o600, flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    if (!mappingBytes.equals(await readFile(mappingPath)))
      throw new Error("Frozen renderer mapping mismatch");
    await chmod(mappingPath, 0o600);
    rendererMapping = { path: mappingPath, sha256: mappingHash, bytes: mappingBytes.length };
  }
  const path = join(directory, `${sha256}.pdf`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  if (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== sha256
  )
    throw new Error("Frozen document hash mismatch");
  await chmod(path, 0o600);
  const docxBytes = await draftDocx(tailored, directory);
  let docx: DocumentManifest["docx"] = {
    status: "unavailable",
    reason: "Local zip dependency is unavailable",
  };
  if (docxBytes) {
    const docxHash = createHash("sha256").update(docxBytes).digest("hex");
    const docxPath = join(directory, `${docxHash}.docx`);
    await writeFile(docxPath, docxBytes, { mode: 0o600, flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    if (
      createHash("sha256")
        .update(await readFile(docxPath))
        .digest("hex") !== docxHash
    )
      throw new Error("Frozen DOCX hash mismatch");
    await chmod(docxPath, 0o600);
    docx = {
      status: "generated",
      path: docxPath,
      sha256: docxHash,
      bytes: docxBytes.length,
      renderQa: "required",
    };
  }
  const manifest: Omit<DocumentManifest, "manifestPath"> = {
    path,
    sha256,
    bytes: bytes.length,
    sourceDigest: options.sourceDigest ?? null,
    status: "draft",
    conflicts: [
      ...(options.conflicts ?? []),
      ...(pageCount > maxPages
        ? [`Resume exceeds the ${maxPages}-page budget; layout review required`]
        : []),
    ],
    renderQa: "required",
    template: renderer,
    rendererVersion,
    rendererConfigHash,
    documentPipelineVersion: pipeline.documentPipelineVersion,
    verifierConfigHash: pipeline.verifierConfigHash,
    ...(rendererMapping && { rendererMapping }),
    verifierVersion: pipeline.verifierVersion,
    generatedAt: new Date().toISOString(),
    data: tailored,
    tailoringMode: rewritten ? "reviewed_rewrite" : "extractive",
    proposalHash: options.reviewedProposal
      ? tailoringHash(options.reviewedProposal.proposal)
      : null,
    pageCount,
    maxPages,
    pageLimitExceeded: pageCount > maxPages,
    docx,
  };
  return freezeDocumentProvenance(directory, manifest);
}
