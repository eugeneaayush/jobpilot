import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResumeData } from "@jobpilot/contracts/resume";
import { Document, Page, renderToBuffer, Text } from "@react-pdf/renderer";
import { manifestHash, readPrivateArtifact } from "../persistence-policy";
import { sha256 } from "../runtime";
import { applyReviewedProposal, type ReviewedProposal } from "../tailoring/proposal";

export function coverLetterContent(
  data: ResumeData,
  job: { title: string; company: string },
  reviewed?: ReviewedProposal,
) {
  const citations = [{ pointer: "/basics/name", value: data.basics.name }];
  const cite = (pointer: string, value: string) => {
    if (!citations.some((citation) => citation.pointer === pointer))
      citations.push({ pointer, value });
    return value;
  };
  const paragraphs = [
    "Dear Hiring Team,",
    `I am applying for the ${job.title} position at ${job.company}. Thank you for considering my application.`,
  ];
  if (reviewed) {
    applyReviewedProposal(data, reviewed);
    if (!reviewed.proposal.essayClaims.length)
      throw new Error("Reviewed cover-letter claims are missing");
    for (const claim of reviewed.proposal.essayClaims) {
      paragraphs.push(claim.text);
      for (const citation of claim.citations) {
        const fact = reviewed.input.facts.find((item) => item.id === citation.factId)!;
        cite(fact.pointer, fact.quote);
      }
    }
    paragraphs.push("Thank you for considering my application.", "Sincerely,", data.basics.name);
    return { paragraphs, citations, resumeDataHash: manifestHash(data) };
  }
  const educationIndex = data.education.findIndex((education) =>
    /\bMBA\b|master.*business administration/i.test(education.degree),
  );
  const education = data.education[educationIndex];
  if (education) {
    const degree = cite(`/education/${educationIndex}/degree`, education.degree);
    const school = cite(`/education/${educationIndex}/school`, education.school);
    paragraphs.push(
      /candidate/i.test(degree)
        ? `I am an MBA candidate at ${school}.`
        : `My education includes ${degree} at ${school}.`,
    );
  }
  const first = data.experience[0];
  if (first) {
    const title = cite("/experience/0/title", first.title);
    const company = cite("/experience/0/company", first.company);
    paragraphs.push(`My experience includes ${title} at ${company}.`);
  }
  const keywords = new Set(
    job.title
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3),
  );
  if (/invest|ventur|capital|financ|equity|fund|portfolio|buyside|buy.side/i.test(job.title))
    for (const word of [
      "invest",
      "portfolio",
      "financ",
      "valuation",
      "venture",
      "acquisition",
      "capital",
      "deal",
    ])
      keywords.add(word);
  if (/product|technology|technical|software/i.test(job.title))
    for (const word of ["product", "platform", "develop", "analytics", "engineer", "data"])
      keywords.add(word);
  if (/consult|strategy/i.test(job.title))
    for (const word of ["strateg", "analysis", "led", "client", "operation", "improv"])
      keywords.add(word);
  const selected = data.experience
    .flatMap((experience, experienceIndex) =>
      experience.bullets.map((bullet, bulletIndex) => ({
        experience,
        experienceIndex,
        bullet,
        bulletIndex,
        score: [...keywords].filter((word) => bullet.toLowerCase().includes(word)).length,
      })),
    )
    .sort(
      (a, b) =>
        b.score - a.score || a.experienceIndex - b.experienceIndex || a.bulletIndex - b.bulletIndex,
    )
    .slice(0, 2);
  for (const entry of selected) {
    const prefix = `/experience/${entry.experienceIndex}`;
    const title = cite(`${prefix}/title`, entry.experience.title);
    const company = cite(`${prefix}/company`, entry.experience.company);
    const bullet = cite(`${prefix}/bullets/${entry.bulletIndex}`, entry.bullet);
    paragraphs.push(`As ${title} at ${company}: ${bullet}`);
  }
  paragraphs.push(
    "I would welcome the opportunity to discuss my background and learn more about the role.",
    "Sincerely,",
    data.basics.name,
  );
  return { paragraphs, citations, resumeDataHash: manifestHash(data) };
}

export async function generateCoverLetter(
  data: ResumeData,
  job: { title: string; company: string },
  root: string,
  reviewed?: ReviewedProposal,
) {
  const content = coverLetterContent(data, job, reviewed);
  // Fixed metadata makes identical facts and target produce identical PDF bytes.
  const epoch = new Date("2000-01-01T00:00:00.000Z");
  const bytes = await renderToBuffer(
    <Document
      title="Cover letter"
      author={data.basics.name}
      creationDate={epoch}
      modificationDate={epoch}
    >
      <Page
        size="LETTER"
        style={{ fontFamily: "Times-Roman", fontSize: 11, padding: 54, lineHeight: 1.35 }}
      >
        {content.paragraphs.map((text) => (
          <Text key={text} style={{ marginBottom: 14 }}>
            {text}
          </Text>
        ))}
      </Page>
    </Document>,
  );
  const hash = sha256(bytes);
  const directory = join(root, "attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(directory, 0o700);
  const path = join(directory, `${hash}.pdf`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  if (sha256(await readPrivateArtifact(path, root)) !== hash)
    throw new Error("Frozen cover letter hash mismatch");
  await chmod(path, 0o600);
  return {
    path,
    sha256: hash,
    bytes: bytes.length,
    citations: content.citations,
    resumeDataHash: content.resumeDataHash,
  };
}
