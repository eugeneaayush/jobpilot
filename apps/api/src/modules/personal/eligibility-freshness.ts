import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type { PersonalRecord, PersonalResumeEvidence, Prisma } from "@/generated/prisma/client";
import { assessPostingDeadlines } from "./deadline-policy";
import { manifestHash } from "./persistence-policy";
import { recoveryContext } from "./recovery-policy";
import { objectValue } from "./runtime";

type EligibilityRecord = Pick<
  PersonalRecord,
  "identity" | "title" | "company" | "url" | "requisitionId" | "details"
>;
type EligibilityEvidence = Pick<PersonalResumeEvidence, "id" | "sourceHash" | "details">;
export interface EligibilitySources {
  settings: PersonalSettings;
  evidence: EligibilityEvidence;
}

export function eligibilityContext(
  record: EligibilityRecord,
  sources: EligibilitySources,
  now = Date.now(),
) {
  const posting = objectValue(objectValue(record.details).posting);
  const deadlines = assessPostingDeadlines(
    {
      descriptionText: typeof posting.descriptionText === "string" ? posting.descriptionText : "",
      deadline: typeof posting.deadline === "string" ? posting.deadline : null,
    },
    now,
  );
  return {
    // Invalidate stored decisions when requirement extraction changes, even if source text does not.
    version: 5,
    deadlineStatus: deadlines.map(({ status, precision, calendarDate }) => ({
      status,
      precision,
      calendarDate,
    })),
    ...recoveryContext(record, sources.settings, sources.evidence),
    postingFieldsHash: manifestHash({
      identity: record.identity,
      title: record.title,
      company: record.company,
      url: record.url,
      requisitionId: record.requisitionId,
      posting: objectValue(record.details).posting ?? null,
    }),
  };
}

export function eligibilityFreshness(
  record: EligibilityRecord,
  sources?: EligibilitySources,
  now = Date.now(),
) {
  if (!sources)
    return { status: "unknown" as const, reason: "Current eligibility sources are unavailable" };
  const saved = objectValue(record.details).eligibilityContext;
  if (saved && manifestHash(saved) === manifestHash(eligibilityContext(record, sources, now)))
    return { status: "current" as const, reason: null };
  return {
    status: "stale" as const,
    reason: "Eligibility needs refresh against the current posting, settings and resume evidence",
  };
}

export function eligibilityRefreshClaimed(record: Pick<PersonalRecord, "state" | "details">) {
  if (["applying", "submitted", "submission_uncertain"].includes(record.state)) return true;
  const details = objectValue(record.details);
  return ["preparation", "tailoring"].some((key) => {
    const claim = objectValue(details[key]);
    return claim.status === "running" && Date.parse(String(claim.leaseExpiresAt)) > Date.now();
  });
}

export function eligibilityRefreshAttemptWhere(userId: string): Prisma.PersonalAttemptWhereInput {
  return {
    userId,
    OR: [
      {
        state: {
          in: ["preparing", "prepared", "submitting", "submitted", "submission_uncertain"],
        },
      },
      { submitAt: { not: null } },
    ],
  };
}
