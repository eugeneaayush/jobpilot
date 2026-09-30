import {
  type PersonalCampaign,
  personalCampaignCreateSchema,
} from "@jobpilot/contracts/personal-campaign";
import { personalScreeningValueSchema } from "@jobpilot/contracts/personal-readiness";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { z } from "zod";
import { conflict } from "@/common/errors";
import type { Campaign, PersonalRecord } from "@/generated/prisma/client";
import { evaluateCampaignRoleScope } from "./campaign-role-scope";
import { seniorityParkReason } from "./graduate-policy";

const campaignAuthorizationSchema = z.object({
  runId: z.uuid(),
  authorizedAt: z.string(),
  settingsHash: z.string(),
  resumeEvidenceId: z.uuid(),
  sourceHash: z.string(),
  snapshotHash: z.string(),
  settings: z.record(z.string(), z.unknown()),
});
const personalSchedulerPolicySchema = personalCampaignCreateSchema.extend({
  scheduler: z.literal("personal-campaign-v1"),
  approvalPolicy: z.literal("per-application-v1"),
  enabled: z.boolean(),
  policyVersion: z.string(),
  authorization: campaignAuthorizationSchema.nullable(),
});
export type SchedulerPolicy = z.infer<typeof personalSchedulerPolicySchema>;
export function schedulerPolicy(config: unknown) {
  const result = z.object({ personal: personalSchedulerPolicySchema }).safeParse(config);
  if (!result.success) throw conflict("This is not a configured personal campaign.");
  return result.data.personal;
}
export function personalCampaignDto(campaign: Campaign): PersonalCampaign {
  const policy = schedulerPolicy(campaign.config);
  return {
    id: campaign.campaignId,
    name: policy.name,
    mode: policy.mode,
    sources: policy.sources,
    tracks: policy.tracks,
    ...(policy.roleScope && { roleScope: policy.roleScope }),
    fitThreshold: policy.fitThreshold,
    dailyCap: policy.dailyCap,
    maxApplications: policy.maxApplications,
    timezone: policy.timezone,
    status: campaign.status === "in_progress" && policy.enabled ? "active" : "stopped",
    policyVersion: policy.policyVersion,
    createdAt: campaign.startedAt,
    updatedAt: campaign.updatedAt,
    authorization: policy.authorization
      ? {
          runId: policy.authorization.runId,
          authorizedAt: policy.authorization.authorizedAt,
          settingsHash: policy.authorization.settingsHash,
          resumeEvidenceId: policy.authorization.resumeEvidenceId,
          sourceHash: policy.authorization.sourceHash,
          snapshotHash: policy.authorization.snapshotHash,
        }
      : null,
  };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function recordScopeParkReason(
  record: Pick<PersonalRecord, "identity" | "track" | "details" | "title" | "company">,
  policy: Partial<Pick<SchedulerPolicy, "tracks" | "sources" | "roleScope">>,
): string | null {
  const seniorityReason = seniorityParkReason(record);
  if (seniorityReason) return seniorityReason;
  if (!policy.tracks?.includes(record.track)) return "Track is outside the campaign policy";
  if (
    !policy.sources?.boardTokens.some((token) =>
      record.identity.startsWith(`greenhouse:${token}:`),
    ) &&
    !policy.sources?.instances?.some((source) =>
      record.identity.startsWith(`${personalSourceIdentity(source)}:`),
    )
  )
    return "Source is outside the campaign policy";
  if (policy.roleScope) {
    const scope = evaluateCampaignRoleScope(record, policy.roleScope);
    if (scope.decision !== "in_scope") return `Campaign role scope: ${scope.reasons.join("; ")}`;
  }
  return null;
}
export function recordParkReason(
  record: Pick<PersonalRecord, "identity" | "track" | "state" | "details" | "title" | "company">,
  policy: SchedulerPolicy,
): string | null {
  const scopeReason = recordScopeParkReason(record, policy);
  if (scopeReason) return scopeReason;
  if (record.state !== "prepared") return "Record does not have a prepared preview";
  const details = object(record.details);
  const eligibility = object(details.eligibility);
  if (eligibility.decision === "ineligible") return "Record is ineligible";
  if (!details.preview || !details.document || !details.manifestPath)
    return "Prepared document or manifest is missing";
  if (policy.mode === "offline") return null;
  if (eligibility.decision !== "eligible") return "Eligibility requires an answer";
  if (!Array.isArray(details.missingAnswers) || details.missingAnswers.length)
    return "Required answers are missing";
  const preview = object(details.preview);
  if (
    preview.readiness !== "ready" ||
    preview.renderReviewed !== true ||
    !Array.isArray(preview.conflicts) ||
    preview.conflicts.length
  )
    return "Document is draft, unreviewed, or conflicting";
  return null;
}

const answersSchema = z.array(
  z.object({
    key: z.string().min(1),
    value: personalScreeningValueSchema,
    fieldName: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
  }),
);
export function preparedCampaignAnswers(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
    return [];
  const answers = answersSchema.safeParse(value);
  if (!answers.success)
    throw conflict("Prepared answers must be an explicit array of exact field values");
  if (new Set(answers.data.map((answer) => answer.key)).size !== answers.data.length)
    throw conflict("Prepared answer keys must be unique");
  return answers.data;
}
