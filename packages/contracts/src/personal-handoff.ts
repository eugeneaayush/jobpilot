import { z } from "zod";

export const PERSONAL_HANDOFF_REASONS = [
  "login",
  "account_creation",
  "captcha",
  "terms",
  "security_warning",
  "verification",
] as const;
const PERSONAL_HANDOFF_STATUSES = [
  "parked",
  "opening",
  "open",
  "resuming",
  "resolved",
  "cancelled",
  "expired",
] as const;

const allowedOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["https:", "http:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}, "An HTTP(S) origin without credentials, path or query is required");

export const personalHandoffLeaseSchema = z.object({
  handoffId: z.uuid(),
  leaseOwner: z.string().min(1).max(200),
  leaseGeneration: z.number().int().positive(),
  proofHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const personalHandoffResponseSchema = z.object({
  handoffId: z.uuid(),
  attemptId: z.uuid(),
  recordId: z.uuid(),
  profileKey: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  allowedOrigin,
  reason: z.enum(PERSONAL_HANDOFF_REASONS),
  status: z.enum(PERSONAL_HANDOFF_STATUSES),
  leaseOwner: z.string().min(1).max(200),
  leaseGeneration: z.number().int().positive(),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
  taskId: z.uuid().nullable().optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  browserOpen: z.boolean().optional(),
  events: z
    .array(
      z.object({
        sequence: z.number().int().nonnegative(),
        at: z.iso.datetime({ offset: true }),
        type: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type PersonalHandoffLease = z.infer<typeof personalHandoffLeaseSchema>;
export type PersonalHandoff = z.infer<typeof personalHandoffResponseSchema>;
