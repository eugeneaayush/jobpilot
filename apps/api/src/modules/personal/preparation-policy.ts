import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type { ResumeData } from "@jobpilot/contracts/resume";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { manifestHash } from "./persistence-policy";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function preparationPreviewHash(
  record: Pick<PersonalRecord, "id" | "identity" | "details">,
  settings: PersonalSettings,
  evidence: Pick<PersonalResumeEvidence, "id" | "sourceHash" | "details">,
  data: ResumeData,
) {
  const details = object(record.details);
  const posting = object(details.posting);
  return manifestHash({
    ...documentPipelineInputs(settings.resumeRenderer ?? "cbs-letter-times"),
    documentEdits: details.documentEdits ?? null,
    posting: typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting),
    settings,
    evidence,
    data,
    screeningAnswers: details.screeningAnswers ?? null,
    attachmentRequirements: details.attachmentRequirements ?? null,
    attachments: details.attachments ?? [],
  });
}
