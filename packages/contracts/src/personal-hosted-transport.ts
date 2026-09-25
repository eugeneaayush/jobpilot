import { z } from "zod";
import { personalAttemptLeaseSchema } from "./personal-attempt";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const personalHostedTransportFreezeSchema = personalAttemptLeaseSchema
  .extend({
    evidenceHash: hash,
  })
  .strict();
export type PersonalHostedTransportFreezeInput = z.infer<
  typeof personalHostedTransportFreezeSchema
>;
export const personalHostedTransportResponseSchema = z
  .object({
    attemptId: z.uuid(),
    provider: z.literal("lever"),
    status: z.literal("frozen"),
    evidenceHash: hash,
    manifestHash: hash,
    targetUrl: z.url(),
    requestBodyHash: hash,
    applicationPayloadHash: hash,
    capturedAt: z.date(),
  })
  .strict();
