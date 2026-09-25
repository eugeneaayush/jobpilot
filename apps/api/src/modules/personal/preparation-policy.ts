import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type { ResumeData } from "@jobpilot/contracts/resume";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import { postingContentHash } from "./attachments-policy";
import { manifestHash } from "./persistence-policy";
import { objectValue } from "./runtime";

export function preparationPreviewHash(
  record: Pick<PersonalRecord, "id" | "identity" | "details">,
  settings: PersonalSettings,
  evidence: Pick<PersonalResumeEvidence, "id" | "sourceHash" | "details">,
  data: ResumeData,
) {
  const details = objectValue(record.details);
  return manifestHash({
    posting: postingContentHash(record),
    settings,
    evidence,
    data,
    screeningAnswers: details.screeningAnswers ?? null,
    attachmentRequirements: details.attachmentRequirements ?? null,
    attachments: details.attachments ?? [],
  });
}
