import { z } from "zod/v4";
import { PERSONAL_ATTEMPT_STATES } from "./personal-attempt";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.string().max(20000), z.boolean(), z.number().finite()]);
const status = z.enum(["satisfied", "violated", "unknown"]);
const pointer = z
  .string()
  .regex(/^(\/(?:[^~]|~[01])*)+$/)
  .max(1000);
const personalRecoveryContextSchema = z
  .object({
    identity: z.string(),
    postingHash: hash,
    settingsHash: hash,
    resumeEvidenceId: z.uuid(),
    sourceHash: hash,
    evidenceHash: hash,
    requirementsHash: hash,
  })
  .strict();
const citation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings"), pointer, value: scalar }).strict(),
  z.object({ kind: z.literal("resume"), pointer, value: scalar }).strict(),
  z
    .object({
      kind: z.literal("screening_answer"),
      snapshotHash: hash,
      key: z.string().max(150),
      value: scalar,
    })
    .strict(),
]);
const decision = z
  .object({
    requirementId: hash,
    status,
    rationale: z.string().trim().min(10).max(2000),
    sourceQuote: z.string().min(1).max(20000),
    citation: citation.optional(),
  })
  .strict()
  .refine(
    (value) => value.status === "unknown" || value.citation !== undefined,
    "Satisfied or violated decisions require an exact stored fact citation",
  );
export const personalEligibilityAdjudicationSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime(),
    context: personalRecoveryContextSchema,
    decisions: z.array(decision).min(1).max(200),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.decisions.map((item) => item.requirementId)).size === value.decisions.length,
    "Requirement decisions must be unique",
  );
export const personalRecordRecoverySchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime(),
    context: personalRecoveryContextSchema,
    attemptId: z.uuid(),
    campaignRunId: z.uuid(),
    targetCampaignId: z.uuid().optional(),
    reason: z.string().trim().min(10).max(2000),
    proof: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("screening_answers"), snapshotHash: hash }).strict(),
      z.object({ kind: z.literal("eligibility"), adjudicationId: z.uuid() }).strict(),
      z.object({ kind: z.literal("browser_session"), sessionId: z.uuid(), sha256: hash }).strict(),
      z.object({ kind: z.literal("retry_failure") }).strict(),
    ]),
  })
  .strict();
export const personalRecoveryQuerySchema = z.object({ targetCampaignId: z.uuid().optional() });
export const personalRecoveryResponseSchema = z.object({
  recordId: z.uuid(),
  updatedAt: z.date(),
  context: personalRecoveryContextSchema,
  source: z.object({ title: z.string(), descriptionText: z.string(), url: z.string() }),
  requirements: z.array(
    z.object({
      id: hash,
      requirement: z.string(),
      evidence: z.string(),
      status,
      candidateEvidence: z.string().nullable(),
    }),
  ),
  eligibility: z.enum(["eligible", "ineligible", "unknown"]),
  latestAttempt: z
    .object({
      id: z.uuid(),
      state: z.enum(PERSONAL_ATTEMPT_STATES),
      submitAt: z.date().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  recovery: z.object({
    allowed: z.boolean(),
    blockers: z.array(z.string()),
    failedAttempts: z.number().int(),
    retriesRemaining: z.number().int(),
    campaignRunId: z.uuid().nullable(),
    targetCampaignId: z.uuid().optional(),
  }),
  history: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(["eligibility", "recovery"]),
      createdAt: z.date(),
      reason: z.string(),
      contextHash: hash,
    }),
  ),
});
export type PersonalRecoveryContext = z.infer<typeof personalRecoveryContextSchema>;
export type PersonalEligibilityAdjudicationInput = z.infer<
  typeof personalEligibilityAdjudicationSchema
>;
export type PersonalRecordRecoveryInput = z.infer<typeof personalRecordRecoverySchema>;
