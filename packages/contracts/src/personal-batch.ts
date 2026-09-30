import { z } from "zod";
import { paginatedSchema, paginationQuerySchema } from "./pagination";
import { PERSONAL_TRACKS } from "./personal-attempt";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z
  .array(z.uuid())
  .min(3)
  .max(5)
  .refine((items) => new Set(items).size === items.length, "Batch members must be unique");
const member = z
  .object({
    recordId: z.uuid(),
    identity: z.string(),
    title: z.string(),
    company: z.string(),
    inputHash: hash,
    postingHash: hash,
    postingTerms: z.array(z.string()),
    supportedByBase: z.array(z.string()),
    absentFromBase: z.array(z.string()),
  })
  .strict();
export const personalBatchAnalysisSchema = z
  .object({
    version: z.literal(1),
    campaignId: z.uuid(),
    runId: z.uuid(),
    evidenceId: z.uuid(),
    sourceHash: hash,
    resumeHash: hash,
    settingsHash: hash,
    track: z.enum(PERSONAL_TRACKS),
    overlap: z
      .object({
        metric: z.literal("pairwise_jaccard"),
        required: z.literal(0.6),
        minimum: z.number().min(0.6).max(1),
      })
      .strict(),
    members: z.array(member).min(3).max(5),
    sharedSupportedTerms: z.array(z.string()),
    missingTerms: z.array(
      z.object({ term: z.string(), recordIds: z.array(z.uuid()).min(1).max(5) }).strict(),
    ),
    sourceQuestion: z.string().nullable(),
  })
  .strict();
export type PersonalBatchAnalysis = z.infer<typeof personalBatchAnalysisSchema>;
export const personalBatchCreateSchema = z
  .object({ campaignId: z.uuid(), recordIds: ids })
  .strict();
export const personalBatchSuggestSchema = z
  .object({
    campaignId: z.uuid(),
    recordIds: z
      .array(z.uuid())
      .min(3)
      .max(50)
      .refine((items) => new Set(items).size === items.length, "Candidates must be unique")
      .optional(),
  })
  .strict();
export const personalBatchSuggestionsSchema = z
  .object({
    examined: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    suggestions: z
      .array(
        z
          .object({
            recordIds: ids,
            roles: z
              .array(z.object({ recordId: z.uuid(), title: z.string(), company: z.string() }))
              .min(3)
              .max(5),
            track: z.enum(PERSONAL_TRACKS),
            minimumOverlap: z.number().min(0.6).max(1),
            sharedSupportedTerms: z.array(z.string()),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export const personalBatchAdvanceSchema = z
  .object({ expectedAnalysisHash: hash, retryBlocked: z.boolean().default(false) })
  .strict();
export const personalBatchSchema = z
  .object({
    id: z.uuid(),
    createdAt: z.date(),
    analysisHash: hash,
    analysis: personalBatchAnalysisSchema,
    status: z.enum(["active", "complete", "stale"]),
    staleReason: z.string().nullable(),
    running: z.boolean(),
    members: z
      .array(
        z
          .object({
            recordId: z.uuid(),
            status: z.enum(["pending", "ready", "blocked"]),
            phase: z
              .enum(["propose", "claim_review", "preview", "render_review", "complete"])
              .nullable(),
            reason: z.string().nullable(),
            nextEligibleAt: z.date().nullable(),
          })
          .strict(),
      )
      .min(3)
      .max(5),
    sourceQuestion: z
      .object({
        id: z.uuid(),
        prompt: z.string(),
        status: z.enum(["open", "answered", "expired", "cancelled"]),
        answer: z.string().nullable(),
        requiresSourceAcceptance: z.literal(true),
      })
      .strict()
      .nullable(),
    lastAdvancedRecordId: z.uuid().nullable(),
  })
  .strict();
export type PersonalBatch = z.infer<typeof personalBatchSchema>;
export const personalBatchQuerySchema = paginationQuerySchema;
export const personalBatchListSchema = paginatedSchema(personalBatchSchema);
