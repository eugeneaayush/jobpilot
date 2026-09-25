import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateWrite, run, runtimeRoot } from "./common";

/** An explicitly synthetic fallback, never mixed with a real applicant's sources. */
export async function syntheticSources(): Promise<{ json: string; docx: string }> {
  const directory = path.join(runtimeRoot, "synthetic-source");
  await mkdir(path.join(directory, "word"), { recursive: true, mode: 0o700 });
  const data = {
    name: "Synthetic Candidate",
    contact: { email: "synthetic@example.invalid" },
    education: [
      { institution: "Example Business School", degree: "MBA", dates: "2026 – 2028", bullets: [] },
    ],
    experience: [
      {
        company: "Example Company",
        title: "Analyst",
        start_date: "2022",
        end_date: "2025",
        bullets: ["Built monthly financial reports using verified source data."],
      },
    ],
    additional: { lines: [{ label: "Skills", text: "Financial analysis; Excel" }] },
  };
  const leaves = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(leaves)
        : [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${leaves(
    data,
  )
    .map(
      (value) =>
        `<w:p><w:r><w:t>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</w:t></w:r></w:p>`,
    )
    .join("")}</w:body></w:document>`;
  const json = path.join(directory, "master.json");
  const docx = path.join(directory, "master.docx");
  await privateWrite(json, data);
  await writeFile(path.join(directory, "word/document.xml"), xml, { mode: 0o600 });
  await run(["zip", "-q", docx, "word/document.xml"], { cwd: directory, quiet: true });
  await chmod(docx, 0o600);
  return { json, docx };
}
