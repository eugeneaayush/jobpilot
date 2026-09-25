import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const personalTailoringReviewSchema = z
  .object({
    sourceDigest: hash,
    inputHash: hash,
    proposalHash: hash,
    independent: z.literal(true),
    claims: z
      .array(
        z
          .object({
            claimId: z.string().min(1).max(80),
            decision: z.enum(["supported", "unsupported", "unknown"]),
            factIds: z.array(hash).min(1).max(20),
            rationale: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
export const personalTailoringResponseSchema = z.object({
  status: z.enum([
    "running",
    "proposed",
    "reviewed",
    "blocked",
    "timed_out",
    "cancelled",
    "missing",
  ]),
  reason: z.string().nullable(),
  inputHash: hash.nullable(),
  proposalHash: hash.nullable(),
  input: z.unknown().nullable(),
  proposal: z.unknown().nullable(),
  review: z.unknown().nullable(),
});
