import { createHash } from "node:crypto";
import {
  type ApplicationEmailMimeProof,
  applicationEmailMimeProofSchema,
  type FrozenApplicationEmail,
  frozenApplicationEmailSchema,
} from "@jobpilot/contracts/personal-application-email";
import { z } from "zod/v4";
import { conflict } from "@/common/errors";
import { manifestHash } from "../persistence-policy";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const base64 = (value: string | Uint8Array) =>
  Buffer.from(value)
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") ?? "";
function encodedSubject(subject: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((text) => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`);
}
export interface PreparedApplicationEmail {
  payload: FrozenApplicationEmail;
  raw: string;
  mimeHash: string;
  messageId: string;
  proof: ApplicationEmailMimeProof;
}

export function buildApplicationEmailMime(
  attemptId: string,
  from: string,
  value: FrozenApplicationEmail,
  attachmentBytes: Uint8Array[],
): PreparedApplicationEmail {
  z.uuid().parse(attemptId);
  const payload = frozenApplicationEmailSchema.parse(value);
  const { payloadHash, ...unhashed } = payload;
  if (
    manifestHash(unhashed) !== payloadHash ||
    attachmentBytes.length !== payload.attachments.length
  )
    throw conflict("Frozen email payload or attachment count changed.");
  const boundary = `jobpilot_${attemptId}_${payloadHash.slice(0, 16)}`;
  const contentType = `multipart/mixed; boundary="${boundary}"`;
  const subjectWords = encodedSubject(payload.subject);
  const subjectHeader = subjectWords.join(" ");
  const messageId = `<jobpilot-${attemptId}@local.jobpilot>`;
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(payload.body)}`,
  ];
  for (const [index, metadata] of payload.attachments.entries()) {
    const bytes = attachmentBytes[index];
    if (
      !bytes ||
      bytes.length !== metadata.bytes ||
      digest(bytes) !== metadata.sha256 ||
      Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-"
    )
      throw conflict("Attachment bytes do not match the frozen PDF.");
    parts.push(
      `--${boundary}\r\nContent-Type: application/pdf; name="${metadata.filename}"\r\nContent-Disposition: attachment; filename="${metadata.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(bytes)}`,
    );
  }
  const body = `${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
  const proof = applicationEmailMimeProofSchema.parse({
    messageId,
    from,
    to: payload.to,
    subjectHeader,
    contentType,
    bodySha256: digest(payload.body),
    mimeBodySha256: digest(body),
    attachments: payload.attachments,
  });
  const raw = [
    `From: ${from}`,
    `To: ${payload.to}`,
    `Subject: ${subjectWords.join("\r\n ")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
    "",
    body,
  ].join("\r\n");
  return { payload, raw, mimeHash: digest(raw), messageId, proof };
}

export function matchesApplicationEmailMime(
  raw: string,
  value: ApplicationEmailMimeProof,
): boolean {
  const parsed = applicationEmailMimeProofSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(raw) > 22_000_000) return false;
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0 || split > 100_000) return false;
  const proof = parsed.data;
  if (digest(raw.slice(split + 4)) !== proof.mimeBodySha256) return false;
  const headers = new Map<string, string[]>();
  for (const line of raw
    .slice(0, split)
    .replace(/\r\n[\t ]+/g, " ")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) return false;
    const name = line.slice(0, colon).toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  if (
    headers.has("bcc") ||
    headers.has("cc") ||
    headers.has("resent-to") ||
    headers.has("resent-bcc") ||
    headers.has("resent-cc")
  )
    return false;
  return Object.entries({
    from: proof.from,
    to: proof.to,
    subject: proof.subjectHeader,
    "message-id": proof.messageId,
    "mime-version": "1.0",
    "content-type": proof.contentType,
  }).every(
    ([name, expected]) => headers.get(name)?.length === 1 && headers.get(name)?.[0] === expected,
  );
}
