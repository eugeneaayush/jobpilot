import { z } from "zod";

export const personalPreparationRequestSchema = z.object({ campaignId: z.uuid() }).strict();
export const personalPreparationResponseSchema = z.object({
  status: z.enum(["pending", "running", "ready", "blocked"]),
  phase: z.enum(["propose", "claim_review", "preview", "render_review", "complete"]),
  reason: z.string().nullable(),
  nextEligibleAt: z.string().nullable(),
  recordUpdatedAt: z.date().optional(),
});
