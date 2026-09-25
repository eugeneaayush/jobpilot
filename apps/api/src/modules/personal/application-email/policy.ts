import {
  type ApplicationEmailAttachment,
  type FrozenApplicationEmail,
  frozenApplicationEmailSchema,
  type PersonalApplicationEmailInput,
  personalApplicationEmailInputSchema,
} from "@jobpilot/contracts/personal-application-email";
import { z } from "zod/v4";
import { conflict } from "@/common/errors";
import { manifestHash } from "../persistence-policy";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const detailsSchema = z.object({
  posting: z.object({ contentHash: hash, descriptionText: z.string().min(1), url: z.url() }),
  verifiedEmployerCareerSource: z.object({
    url: z.url(),
    postingContentHash: hash,
    verifiedAt: z.iso.datetime(),
    evidence: z.object({ sourceUrl: z.url(), quote: z.string().min(1), sha256: hash }),
  }),
  document: z.object({ sha256: hash }),
  preview: z.object({
    pdfHash: hash,
    readiness: z.literal("ready"),
    renderReviewed: z.literal(true),
    conflicts: z.array(z.unknown()).length(0),
    manifestHash: hash,
  }),
  previewAttachments: z.object({ attachments: z.array(z.unknown()) }),
  attachments: z.array(z.unknown()).optional(),
  missingAnswers: z.array(z.string()).length(0).optional(),
  resumeEvidenceId: z.string().optional(),
});
const extraSchema = z.object({
  kind: z.literal("cover_letter"),
  identity: z.string(),
  postingContentHash: hash,
  sha256: hash,
  bytes: z.number().int().positive(),
  source: z.object({ resumeEvidenceId: z.string() }),
  review: z.object({ inspected: z.literal(true), pdfHash: hash }),
});
const genericDomains = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "greenhouse.io",
  "greenhouse.com",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "workdayjobs.com",
  "workday.com",
  "smartrecruiters.com",
  "icims.com",
  "taleo.net",
  "workable.com",
  "breezy.hr",
  "bamboohr.com",
  "jobvite.com",
  "applytojob.com",
  "linkedin.com",
  "indeed.com",
];
function employerDomain(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw conflict("An HTTPS employer-owned careers source is required.");
  const host = url.hostname.toLowerCase();
  if (genericDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)))
    throw conflict("A generic ATS or mailbox domain cannot establish employer ownership.");
  const domain = host.replace(/^(?:(?:www|careers|career|jobs|recruiting)\.)+/, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain))
    throw conflict("Employer domain is invalid.");
  return domain;
}

export function prepareApplicationEmail(
  value: PersonalApplicationEmailInput,
  record: { id: string; identity: string; url: string; details: unknown },
  attachments: ApplicationEmailAttachment[],
): FrozenApplicationEmail {
  const input = personalApplicationEmailInputSchema.parse(value);
  const parsed = detailsSchema.safeParse(record.details);
  if (!parsed.success)
    throw conflict("A verified employer source and current reviewed PDF preview are required.");
  const details = parsed.data;
  const source = details.verifiedEmployerCareerSource;
  if (
    source.postingContentHash !== details.posting.contentHash ||
    details.document.sha256 !== details.preview.pdfHash
  )
    throw conflict("Employer source or document evidence no longer matches this posting.");
  if (
    new URL(input.sourceUrl).href !== new URL(details.posting.url).href ||
    new URL(record.url).href !== new URL(details.posting.url).href ||
    !details.posting.descriptionText.includes(input.sourceQuote)
  )
    throw conflict("Application instructions must quote this stored posting exactly.");
  const domain = employerDomain(source.url);
  if (input.to.split("@")[1]?.toLowerCase() !== domain)
    throw conflict("Application recipient must match the verified employer domain.");
  const addresses =
    input.sourceQuote.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  if (!addresses.some((address) => address.toLowerCase() === input.to.toLowerCase()))
    throw conflict("The quoted instruction must name the exact application recipient.");
  // Inspect whole source sentences so selecting a substring cannot remove a preceding prohibition.
  const sentences = details.posting.descriptionText.split(/\n|(?<=[.!?])\s+/);
  const instruction = sentences.find(
    (sentence) =>
      sentence.includes(input.sourceQuote) ||
      (input.sourceQuote.includes(sentence) &&
        sentence.toLowerCase().includes(input.to.toLowerCase())),
  );
  if (
    !instruction ||
    /\b(?:do not|don't|must not|never|cannot|can't|will not|may not|not accepted|not allowed|not permitted|no applications|no resumes|no email|questions|inquiries|enquiries)\b/i.test(
      instruction,
    ) ||
    new Set(
      (
        instruction.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []
      ).map((address) => address.toLowerCase()),
    ).size !== 1 ||
    !/\b(?:email|e-mail|send|submit)\b/i.test(instruction) ||
    !/\b(?:apply|application|applications|resume|résumé|cv)\b/i.test(instruction) ||
    !instruction.toLowerCase().includes(input.to.toLowerCase())
  )
    throw conflict(
      "The source must explicitly instruct applicants to email an application to this recipient.",
    );
  if (
    manifestHash(details.previewAttachments.attachments) !== manifestHash(details.attachments ?? [])
  )
    throw conflict("Attachments changed since the reviewed preview.");
  const resumes = attachments.filter((attachment) => attachment.kind === "resume");
  if (resumes.length !== 1 || resumes[0]?.sha256 !== details.document.sha256)
    throw conflict("The current frozen resume PDF is required.");
  const extras = attachments.filter((attachment) => attachment.kind !== "resume");
  if (extras.length !== details.previewAttachments.attachments.length)
    throw conflict("Only the complete set of current frozen PDF attachments may be sent.");
  for (const stored of details.previewAttachments.attachments) {
    const extra = extraSchema.safeParse(stored);
    if (
      !extra.success ||
      extra.data.identity !== record.identity ||
      extra.data.postingContentHash !== details.posting.contentHash ||
      extra.data.review.pdfHash !== extra.data.sha256 ||
      !details.resumeEvidenceId ||
      extra.data.source.resumeEvidenceId !== details.resumeEvidenceId ||
      extras.filter((item) => item.sha256 === extra.data.sha256 && item.bytes === extra.data.bytes)
        .length !== 1
    )
      throw conflict("An attachment lacks current candidate and PDF review evidence.");
  }
  if (
    new Set(attachments.map((attachment) => attachment.filename)).size !== attachments.length ||
    attachments.reduce((total, item) => total + item.bytes, 0) > 15_000_000
  )
    throw conflict("Application attachments exceed bounds or repeat a filename.");
  const payload = {
    ...input,
    schemaVersion: 1 as const,
    recordId: record.id,
    identity: record.identity,
    postingContentHash: details.posting.contentHash,
    previewManifestHash: details.preview.manifestHash,
    verifiedCareerSourceHash: manifestHash(source),
    attachments,
  };
  return frozenApplicationEmailSchema.parse({ ...payload, payloadHash: manifestHash(payload) });
}
