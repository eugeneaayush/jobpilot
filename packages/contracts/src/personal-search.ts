import { z } from "zod";

export const PERSONAL_SPEND_CATEGORIES = ["search", "tailoring", "other"] as const;
export const PERSONAL_SPEND_STATUSES = [
  "reserved",
  "completed",
  "blocked",
  "failed",
  "uncertain",
] as const;
export const personalSearchSchema = z
  .object({
    campaignId: z.uuid().optional(),
    runId: z.uuid().optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .refine(
        (value) => value.split(/\s+/).length <= 75 && !/\p{Cc}/u.test(value),
        "Search query exceeds limits or contains control characters",
      ),
    maxPages: z.number().int().min(1).max(10).default(3),
    pageSize: z.number().int().min(1).max(20).default(20),
  })
  .strict();
export type PersonalSearchInput = z.input<typeof personalSearchSchema>;

const personalSearchCandidateSchema = z.object({
  kind: z.literal("career_url_candidate"),
  url: z.url(),
  urlHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  snippet: z.string().nullable(),
  evidence: z.literal("search_snippet"),
  fullDescriptionAvailable: z.literal(false),
  employerIdentityVerified: z.literal(false),
  page: z.number().int().min(0).max(9),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PersonalSearchCandidate = z.infer<typeof personalSearchCandidateSchema>;

const personalSearchBudgetSchema = z.object({
  month: z.string(),
  timezone: z.string(),
  monthlyLimitMicrousd: z.number().int(),
  searchLimitMicrousd: z.number().int(),
  monthlyReservedMicrousd: z.number().int(),
  searchReservedMicrousd: z.number().int(),
  tracking: z.literal("local_reservations"),
  actualProviderBillKnown: z.literal(false),
});
export type PersonalSearchBudget = z.infer<typeof personalSearchBudgetSchema>;
const personalSearchReceiptSchema = z.object({
  reservationId: z.uuid(),
  status: z.enum(PERSONAL_SPEND_STATUSES),
  amountMicrousd: z.number().int(),
  page: z.number().int(),
  sourceUrlHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseHash: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  observedCount: z.number().int(),
  nextEligibleAt: z.date().nullable(),
  reason: z.string().nullable(),
});
export type PersonalSearchReceipt = z.infer<typeof personalSearchReceiptSchema>;
export const personalSearchResponseSchema = z.object({
  provider: z.literal("brave"),
  status: z.enum([
    "missing_setup",
    "budget_exhausted",
    "cooldown",
    "complete",
    "partial",
    "blocked",
    "failed",
  ]),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(personalSearchCandidateSchema),
  coverage: z.object({
    scope: z.literal("search_query"),
    exhausted: z.boolean(),
    empty: z.boolean().nullable(),
    pagesRequested: z.number().int(),
    observedCount: z.number().int(),
    invalidCount: z.number().int(),
    duplicateCount: z.number().int(),
    moreResultsAvailable: z.boolean().nullable(),
  }),
  receipts: z.array(personalSearchReceiptSchema),
  budget: personalSearchBudgetSchema.nullable(),
  nextEligibleAt: z.date().nullable(),
  reasons: z.array(z.string()),
  price: z.object({
    requestMicrousd: z.number().int(),
    verifiedOn: z.literal("2026-09-16"),
    sourceUrl: z.literal("https://brave.com/search/api/"),
    creditsAssumed: z.literal(false),
  }),
});
export type PersonalSearchResponse = z.infer<typeof personalSearchResponseSchema>;
