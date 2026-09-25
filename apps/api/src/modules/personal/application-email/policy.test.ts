import { createHash } from "node:crypto";
import { manifestHash } from "../persistence-policy";
import { prepareApplicationEmail } from "./policy";
import { describe, expect, it } from "bun:test";

const pdf = Buffer.from("%PDF-1.7\nSynthetic resume\n%%EOF");
const hash = createHash("sha256").update(pdf).digest("hex");
const postingHash = "a".repeat(64);
const sourceUrl = "https://careers.example.com/jobs/123";
const input = {
  to: "applications@example.com",
  subject: "Application for Associate",
  body: "Please find my resume attached.",
  sourceQuote: "To apply, email your resume to applications@example.com.",
  sourceUrl,
};
const attachments = [
  {
    kind: "resume" as const,
    filename: "resume.pdf",
    mimeType: "application/pdf" as const,
    sha256: hash,
    bytes: pdf.length,
  },
];
function record() {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    identity: "official:123",
    url: sourceUrl,
    details: {
      posting: {
        contentHash: postingHash,
        descriptionText: `Associate role. ${input.sourceQuote}`,
        url: sourceUrl,
      },
      verifiedEmployerCareerSource: {
        url: sourceUrl,
        postingContentHash: postingHash,
        verifiedAt: "2026-09-16T12:00:00Z",
        evidence: { sourceUrl, quote: "Official careers page", sha256: "b".repeat(64) },
      },
      document: { path: "/synthetic/resume.pdf", sha256: hash },
      preview: {
        pdfHash: hash,
        readiness: "ready",
        renderReviewed: true,
        conflicts: [],
        manifestHash: "c".repeat(64),
      },
      previewAttachments: { attachments: [] },
      attachments: [],
    },
  };
}

describe("official application email policy", () => {
  it("freezes exact source, authored body, and current PDF bytes", () => {
    const result = prepareApplicationEmail(input, record(), attachments);
    expect(result.body).toBe(input.body);
    expect(result.postingContentHash).toBe(postingHash);
    expect(result.attachments).toEqual(attachments);
    const { payloadHash, ...value } = result;
    expect(payloadHash).toBe(manifestHash(value));
  });
  it.each([
    { to: "applications@example.com\r\nBcc: bad@evil.com" },
    { to: "applications@example.com, bad@evil.com" },
    { subject: "Apply\r\nBcc: bad@evil.com" },
    { sourceQuote: "Invented instruction applications@example.com" },
    { sourceUrl: "https://evil.com/jobs/123" },
    { to: "applications@evil.com" },
  ])("rejects invalid recipients, header injection, or altered source %j", (change) => {
    expect(() => prepareApplicationEmail({ ...input, ...change }, record(), attachments)).toThrow();
  });
  it.each([
    "For questions, contact applications@example.com.",
    "Do not email your resume to applications@example.com.",
    "We cannot accept applications by email to applications@example.com.",
    "Send your resume to hiring@example.com and copy applications@example.com.",
    "Applications must be submitted online. Contact applications@example.com for questions.",
    "To apply, email your resume to applications@example.com.evil.org.",
  ])("does not treat arbitrary contact text as an application instruction: %s", (quote) => {
    const source = record();
    source.details.posting.descriptionText = quote;
    expect(() =>
      prepareApplicationEmail({ ...input, sourceQuote: quote }, source, attachments),
    ).toThrow();
  });
  it("does not erase prohibitions by selecting a smaller source quote", () => {
    const source = record();
    source.details.posting.descriptionText =
      "Do not email your resume to applications@example.com.";
    expect(() =>
      prepareApplicationEmail(
        { ...input, sourceQuote: "email your resume to applications@example.com." },
        source,
        attachments,
      ),
    ).toThrow();
  });
  it("requires a current verified employer domain even for an ATS source", () => {
    const source = record();
    source.details.verifiedEmployerCareerSource.postingContentHash = "d".repeat(64);
    expect(() => prepareApplicationEmail(input, source, attachments)).toThrow();
    source.details.verifiedEmployerCareerSource.postingContentHash = postingHash;
    source.details.verifiedEmployerCareerSource.url = "https://boards.greenhouse.io/example";
    expect(() => prepareApplicationEmail(input, source, attachments)).toThrow();
  });
  it("rejects free mailbox domains despite an exact source quote", () => {
    const source = record();
    source.details.verifiedEmployerCareerSource.url = "https://gmail.com/careers";
    const quote = "To apply, email your resume to hiring@gmail.com.";
    source.details.posting.descriptionText = quote;
    expect(() =>
      prepareApplicationEmail(
        { ...input, to: "hiring@gmail.com", sourceQuote: quote },
        source,
        attachments,
      ),
    ).toThrow();
  });
  it("rejects unreviewed, changed, missing, or extra PDFs", () => {
    const source = record();
    source.details.preview.renderReviewed = false;
    expect(() => prepareApplicationEmail(input, source, attachments)).toThrow();
    expect(() => prepareApplicationEmail(input, record(), [])).toThrow();
    expect(() =>
      prepareApplicationEmail(input, record(), [{ ...attachments[0]!, sha256: "f".repeat(64) }]),
    ).toThrow();
    expect(() =>
      prepareApplicationEmail(input, record(), [
        ...attachments,
        { ...attachments[0]!, kind: "cover_letter" },
      ]),
    ).toThrow();
  });
});
