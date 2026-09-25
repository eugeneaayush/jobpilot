import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResumeData } from "@jobpilot/contracts/resume";

const xmlText = (value: string) =>
  [...value]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        [9, 10, 13].includes(code) ||
        (code >= 32 && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff)
      );
    })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export async function draftDocx(data: ResumeData, directory: string): Promise<Buffer | null> {
  const zip = Bun.which("zip");
  if (!zip) return null;
  const staging = await mkdtemp(join(directory, ".docx-"));
  await chmod(staging, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const paragraphs: string[] = [];
    const paragraph = (text: string, bold = false) =>
      paragraphs.push(
        `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="20"/>${bold ? "<w:b/>" : ""}</w:rPr><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`,
      );
    const lines = (items: string[]) => {
      for (const item of items) paragraph(`• ${item}`);
    };
    paragraph(data.basics.name, true);
    paragraph(
      [
        data.basics.location,
        data.basics.phone,
        data.basics.email,
        data.basics.linkedin,
        data.basics.website,
        data.basics.github,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    if (data.summary) paragraph(data.summary);
    if (data.education.length) paragraph("EDUCATION", true);
    for (const item of data.education) {
      paragraph([item.school, item.start, item.end].filter(Boolean).join(" | "), true);
      paragraph(item.degree);
      lines(item.details);
    }
    if (data.experience.length) paragraph("EXPERIENCE", true);
    for (const item of data.experience) {
      paragraph([item.company, item.location].filter(Boolean).join(" | "), true);
      paragraph([item.title, item.start, item.end].filter(Boolean).join(" | "));
      lines(item.bullets);
    }
    if (data.projects.length) paragraph("PROJECTS", true);
    for (const item of data.projects) {
      paragraph(item.name, true);
      if (item.description) paragraph(item.description);
      lines(item.bullets);
    }
    if (
      data.skills.length ||
      data.publications.length ||
      data.awards.length ||
      data.certifications.length
    )
      paragraph("ADDITIONAL INFORMATION", true);
    for (const item of data.skills) paragraph(`${item.group}: ${item.items.join(", ")}`);
    for (const item of data.publications)
      paragraph(
        [item.title, item.authors, item.venue, item.year, item.url, item.doi]
          .filter(Boolean)
          .join("; "),
      );
    for (const item of data.awards)
      paragraph([item.title, item.issuer, item.year, item.description].filter(Boolean).join("; "));
    for (const item of data.certifications)
      paragraph(
        [item.name, item.issuer, item.issued, item.expires, item.credentialId, item.url]
          .filter(Boolean)
          .join("; "),
      );
    for (const section of data.sections) {
      paragraph(section.title.toUpperCase(), true);
      for (const item of section.entries)
        paragraph(
          [`${item.heading}:`, item.subheading, item.meta, ...item.bullets]
            .filter(Boolean)
            .join(" "),
        );
    }
    await mkdir(join(staging, "word"), { mode: 0o700 });
    await mkdir(join(staging, "_rels"), { mode: 0o700 });
    await writeFile(
      join(staging, "[Content_Types].xml"),
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      { mode: 0o600 },
    );
    await writeFile(
      join(staging, "_rels", ".rels"),
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      { mode: 0o600 },
    );
    await writeFile(
      join(staging, "word", "document.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="620" w:right="792" w:bottom="620" w:left="792"/></w:sectPr></w:body></w:document>`,
      { mode: 0o600 },
    );
    const output = join(staging, "draft.docx");
    child = Bun.spawn(
      [zip, "-q", "-X", output, "[Content_Types].xml", "_rels/.rels", "word/document.xml"],
      { cwd: staging, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const exit = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          child?.kill();
          resolve(-1);
        }, 10_000);
      }),
    ]);
    if (exit !== 0) throw new Error("DOCX packaging failed");
    await chmod(output, 0o600);
    return await readFile(output);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill();
    await rm(staging, { recursive: true, force: true });
  }
}
