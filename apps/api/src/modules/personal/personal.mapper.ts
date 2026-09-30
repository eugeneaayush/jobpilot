import { type PersonalRecordDto, personalRecordSchema } from "@jobpilot/contracts/personal";
import type { PersonalRecord } from "@/generated/prisma/client";
import { type EligibilitySources, eligibilityFreshness } from "./eligibility-freshness";
import { recordSeniority } from "./graduate-policy";
import { objectValue, stringsValue } from "./runtime";

export function personalRecordDto(
  record: PersonalRecord,
  sources?: EligibilitySources,
): PersonalRecordDto {
  const details = objectValue(record.details);
  const eligibility = objectValue(details.eligibility);
  const freshness = eligibilityFreshness(record, sources);
  return personalRecordSchema.parse({
    id: record.id,
    campaignId: record.campaignId,
    identity: record.identity,
    title: record.title,
    company: record.company,
    url: record.url,
    requisitionId: record.requisitionId,
    track: record.track,
    state: record.state,
    fitScore: typeof details.fitScore === "number" ? details.fitScore : null,
    fitReasons: stringsValue(details.fitReasons),
    fitEvaluation: details.fitEvaluation ?? null,
    documentVerification: details.documentVerification ?? null,
    seniority: recordSeniority(record),
    eligibility: {
      decision: freshness.status !== "current" ? "unknown" : (eligibility.decision ?? "unknown"),
      reasons: [
        ...stringsValue(eligibility.reasons),
        ...(freshness.status !== "current" ? [freshness.reason] : []),
      ],
    },
    eligibilityFreshness: freshness,
    missingAnswers: stringsValue(details.missingAnswers),
    preview: details.preview ?? null,
    updatedAt: record.updatedAt,
  });
}
