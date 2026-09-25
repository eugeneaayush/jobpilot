import { z } from "zod";
import { personalAttemptLeaseSchema } from "./personal-attempt";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const personalChallengeCodes = [
  "captcha-failed",
  "captcha-retry",
  "invalid-security-code",
  "expired-security-code",
  "security-code-error",
] as const;
export const personalChallengeEvidenceSchema = z.object({ evidenceHash: hash });
export const personalChallengeFreezeSchema = personalAttemptLeaseSchema.extend({
  evidenceHash: hash,
});
export const personalChallengeLeaseSchema = z.object({
  challengeId: z.uuid(),
  leaseOwner: z.string().min(1).max(200),
  explicitUser: z.literal(true),
});
export const personalChallengeFenceSchema = personalAttemptLeaseSchema.extend({
  challengeId: z.uuid(),
});
export const personalChallengeContinueSchema = personalChallengeFenceSchema.extend({
  explicitUser: z.literal(true),
  evidenceHash: hash,
});
export const personalChallengeConsumeSchema = personalChallengeFenceSchema.extend({
  permitId: z.uuid(),
});
export const personalChallengeTransportSchema = z.object({
  manifestHash: hash,
  targetUrl: z.url(),
  applicationPayloadHash: hash,
  requestBodyHash: hash,
  evidenceHash: hash,
});
export const personalChallengeResponseSchema = z.object({
  attemptId: z.uuid(),
  transport: personalChallengeTransportSchema.nullable(),
  challenge: z
    .object({
      challengeId: z.uuid(),
      code: z.enum(personalChallengeCodes),
      status: z.enum([
        "awaiting_user",
        "leased",
        "permitted",
        "continuing",
        "cancelled",
        "expired",
        "resolved",
      ]),
      hasRecipient: z.boolean(),
      leaseOwner: z.string().nullable(),
      leaseGeneration: z.number().int().nonnegative(),
      leaseExpiresAt: z.date().nullable(),
      createdAt: z.date(),
      expiresAt: z.date(),
      evidenceHash: hash,
      permit: z
        .object({
          permitId: z.uuid(),
          status: z.enum(["issued", "consumed"]),
          expiresAt: z.date(),
          requestBodyHash: hash,
          evidenceHash: hash,
        })
        .nullable(),
    })
    .nullable(),
});
export type PersonalChallengeFence = z.infer<typeof personalChallengeFenceSchema>;
