import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type { PersonalBatch } from "@jobpilot/contracts/personal-batch";
import type { ResumeData } from "@jobpilot/contracts/resume";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import { postingContentHash } from "../attachments-policy";
import { resumePageLimit } from "../graduate-policy";
import { preparationPreviewHash } from "../preparation-policy";
import { objectValue } from "../runtime";
import { buildTailoringInput } from "../tailoring/proposal";
import type { BatchCandidate } from "./batch-analysis";

export function batchCandidate(record: PersonalRecord): BatchCandidate {
  const posting = objectValue(objectValue(record.details).posting);
  return {
    id: record.id,
    identity: record.identity,
    title: record.title,
    company: record.company,
    track: record.track,
    postingContentHash: postingContentHash(record),
    posting: {
      title: record.title,
      employer: record.company,
      descriptionText: typeof posting.descriptionText === "string" ? posting.descriptionText : "",
      location: typeof posting.location === "string" ? posting.location : null,
      deadline: typeof posting.deadline === "string" ? posting.deadline : null,
    },
  };
}
export function batchMemberState(
  record: PersonalRecord,
  saved: unknown,
  settings: PersonalSettings,
  evidence: PersonalResumeEvidence,
  data: ResumeData,
): PersonalBatch["members"][number] {
  const details = objectValue(record.details);
  const preview = objectValue(details.preview);
  const tailoring = objectValue(details.tailoring);
  const input = buildTailoringInput(data, {
    sourceDigest: evidence.sourceHash,
    maxPages: resumePageLimit(record),
    job: {
      identity: record.identity,
      title: record.title,
      company: record.company,
      description: String(objectValue(details.posting).descriptionText ?? ""),
      postingContentHash: postingContentHash(record),
    },
  });
  const savedState = objectValue(saved);
  const verification = objectValue(details.documentVerification);
  const document = objectValue(details.document);
  const complete =
    tailoring.status === "reviewed" &&
    objectValue(tailoring.input).inputHash === input.inputHash &&
    preview.preparationContextHash === preparationPreviewHash(record, settings, evidence, data) &&
    preview.renderReviewed === true &&
    verification.status === "passed" &&
    verification.verifierVersion === "1" &&
    typeof preview.pdfHash === "string" &&
    /^[a-f0-9]{64}$/.test(preview.pdfHash) &&
    preview.pdfHash === document.sha256 &&
    verification.artifactSha256 === document.sha256;
  if (complete)
    return {
      recordId: record.id,
      status: preview.readiness === "ready" ? "ready" : "blocked",
      phase: "complete",
      reason:
        preview.readiness === "ready"
          ? null
          : "Document work is complete; required answers or attachments remain unresolved",
      nextEligibleAt: null,
    };
  const phase = ["propose", "claim_review", "preview", "render_review", "complete"].includes(
    String(savedState.phase),
  )
    ? (savedState.phase as PersonalBatch["members"][number]["phase"])
    : null;
  return {
    recordId: record.id,
    status: savedState.status === "blocked" ? "blocked" : "pending",
    phase,
    reason: typeof savedState.reason === "string" ? savedState.reason : null,
    nextEligibleAt:
      typeof savedState.nextEligibleAt === "string" &&
      Number.isFinite(Date.parse(savedState.nextEligibleAt))
        ? new Date(savedState.nextEligibleAt)
        : null,
  };
}
