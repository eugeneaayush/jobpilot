import { z } from "zod/v4";
import {
  frozenApplicationEmailSchema,
  personalApplicationEmailInputSchema,
} from "./personal-application-email";
import { PERSONAL_ATTEMPT_STATES, personalAttemptLeaseSchema } from "./personal-attempt";

export const personalApplicationEmailPrepareSchema = personalApplicationEmailInputSchema
  .extend({
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict();
export const personalApplicationEmailDispatchSchema = personalAttemptLeaseSchema.strict();
export const personalApplicationEmailDraftResponseSchema = z.object({
  recordId: z.uuid(),
  updatedAt: z.date(),
  payload: frozenApplicationEmailSchema,
});
export const personalApplicationEmailResultSchema = z.object({
  attemptId: z.uuid(),
  attemptState: z.enum(PERSONAL_ATTEMPT_STATES),
  updatedAt: z.date(),
  status: z.enum(["blocked", "provider_accepted", "provider_sent_verified", "uncertain"]),
  reason: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  threadId: z.string().nullable(),
  payloadHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  mimeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  messageId: z.string().nullable(),
  employerAcknowledged: z.literal(false),
  canResend: z.literal(false),
});
export type PersonalApplicationEmailPrepareInput = z.infer<
  typeof personalApplicationEmailPrepareSchema
>;
