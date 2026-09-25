import { z } from "zod";

export const PERSONAL_TRACKS = [
  "mba_internship",
  "post_mba_fulltime",
  "general_professional",
] as const;
export const PERSONAL_RECORD_STATES = [
  "discovered",
  "eligible",
  "prepared",
  "applying",
  "submitted",
  "blocked",
  "failed",
  "submission_uncertain",
] as const;
export const PERSONAL_DISCOVERY_STATUSES = ["complete", "partial", "failed", "blocked"] as const;
export const PERSONAL_ATTEMPT_MODES = ["offline", "live_preview", "submit"] as const;
export const PERSONAL_ATTEMPT_STATES = [
  "previewed",
  "preparing",
  "prepared",
  "submitting",
  "submitted",
  "blocked",
  "failed",
  "submission_uncertain",
  "cancelled",
] as const;

export const personalAttemptLeaseSchema = z.object({
  leaseOwner: z.string().min(1).max(200),
  leaseGeneration: z.number().int().positive(),
});
export const personalAttemptStartSchema = z.object({
  recordId: z.uuid(),
  campaignId: z.uuid(),
  mode: z.enum(PERSONAL_ATTEMPT_MODES),
  leaseOwner: z.string().min(1).max(200),
  manifest: z.record(z.string(), z.json()),
});
const personalReceiptEvidenceSchema = z.object({
  outcome: z.enum(["submitted", "not_submitted", "uncertain"]),
  kind: z.enum(["confirmation_page", "confirmation_email", "ats_status", "manual_review"]),
  artifactPath: z.string().min(1).max(2000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.url(),
  capturedAt: z.iso.datetime(),
  externalReference: z.string().min(1).max(2000).optional(),
  details: z.string().min(1).max(10000),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const personalAttemptReceiptSchema = personalAttemptLeaseSchema.extend({
  evidence: personalReceiptEvidenceSchema,
});
export const personalAttemptReconcileSchema = z.object({ evidence: personalReceiptEvidenceSchema });
export const personalAttemptResponseSchema = z.object({
  id: z.uuid(),
  recordId: z.uuid(),
  userId: z.uuid(),
  campaignId: z.uuid(),
  mode: z.enum(PERSONAL_ATTEMPT_MODES),
  state: z.enum(PERSONAL_ATTEMPT_STATES),
  manifest: z.json(),
  manifestHash: z.string(),
  leaseOwner: z.string(),
  leaseGeneration: z.number().int(),
  leaseExpiresAt: z.date(),
  startedAt: z.date(),
  updatedAt: z.date(),
  submitAt: z.date().nullable(),
  receipt: z.json().nullable(),
  attemptNo: z.number().int(),
  policyDay: z.string(),
});
export type PersonalAttemptStartInput = z.infer<typeof personalAttemptStartSchema>;
export type PersonalAttemptLeaseInput = z.infer<typeof personalAttemptLeaseSchema>;
export type PersonalReceiptEvidence = z.infer<typeof personalReceiptEvidenceSchema>;

export const personalAttemptFinishPreviewSchema = personalAttemptLeaseSchema.extend({
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const personalAttemptParkSchema = personalAttemptLeaseSchema.extend({
  kind: z.enum(["blocked", "failed"]),
  reason: z.string().trim().min(1).max(2000),
});
