import { createHash } from "node:crypto";
import { manifestHash } from "../persistence-policy";
import { buildApplicationEmailMime, matchesApplicationEmailMime } from "./mime";
import { describe, expect, it } from "bun:test";

const bytes = Buffer.from("%PDF-1.7\nSynthetic\n%%EOF");
const attachment = {
  kind: "resume" as const,
  filename: "resume.pdf",
  mimeType: "application/pdf" as const,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
};
const base = {
  schemaVersion: 1 as const,
  recordId: "10000000-0000-4000-8000-000000000001",
  identity: "test:123",
  postingContentHash: "a".repeat(64),
  previewManifestHash: "b".repeat(64),
  verifiedCareerSourceHash: "c".repeat(64),
  to: "apply@example.com",
  subject: "Associate résumé",
  body: "An exact authored body\nWith two lines.",
  sourceQuote: "Email your application to apply@example.com.",
  sourceUrl: "https://example.com/careers/123",
  attachments: [attachment],
};
const payload = { ...base, payloadHash: manifestHash(base) };
const attempt = "20000000-0000-4000-8000-000000000001";

describe("application email MIME evidence", () => {
  it("folds long Unicode subjects without changing their source bytes", () => {
    const value = { ...base, subject: "世界 résumé ".repeat(20) };
    const result = buildApplicationEmailMime(
      attempt,
      "candidate@example.net",
      { ...value, payloadHash: manifestHash(value) },
      [bytes],
    );
    const words = result.proof.subjectHeader.split(" ");
    expect(words.every((word) => word.length <= 75)).toBe(true);
    expect(
      words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join(""),
    ).toBe(value.subject);
    expect(matchesApplicationEmailMime(result.raw, result.proof)).toBe(true);
  });
  it("uses a stable Message-ID and binds exact candidate and attachment bytes", () => {
    const result = buildApplicationEmailMime(attempt, "candidate@example.net", payload, [bytes]);
    expect(result.messageId).toBe(`<jobpilot-${attempt}@local.jobpilot>`);
    expect(result).toEqual(
      buildApplicationEmailMime(attempt, "candidate@example.net", payload, [bytes]),
    );
    expect(result.proof.bodySha256).toBe(createHash("sha256").update(payload.body).digest("hex"));
    expect(
      matchesApplicationEmailMime(`Received: by provider\r\n${result.raw}`, result.proof),
    ).toBe(true);
  });
  it("rejects altered PDFs, payloads, from headers, and non-PDF bytes", () => {
    expect(() =>
      buildApplicationEmailMime(attempt, "candidate@example.net", payload, [Buffer.from("bad")]),
    ).toThrow();
    expect(() =>
      buildApplicationEmailMime(attempt, "candidate@example.net\r\nBcc: bad@example.org", payload, [
        bytes,
      ]),
    ).toThrow();
    expect(() =>
      buildApplicationEmailMime(attempt, "candidate@example.net", { ...payload, body: "changed" }, [
        bytes,
      ]),
    ).toThrow();
  });
  it("does not equate matching Message-ID with matching submission", () => {
    const result = buildApplicationEmailMime(attempt, "candidate@example.net", payload, [bytes]);
    expect(
      matchesApplicationEmailMime(
        result.raw.replace("To: apply@example.com", "To: other@example.com"),
        result.proof,
      ),
    ).toBe(false);
    expect(
      matchesApplicationEmailMime(`Bcc: other@example.com\r\n${result.raw}`, result.proof),
    ).toBe(false);
    expect(
      matchesApplicationEmailMime(
        result.raw.replace(bytes.toString("base64"), Buffer.from("tampered").toString("base64")),
        result.proof,
      ),
    ).toBe(false);
    expect(
      matchesApplicationEmailMime(`To: apply@example.com\r\n${result.raw}`, result.proof),
    ).toBe(false);
  });
});
