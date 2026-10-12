import { z } from "zod";
import { paginatedSchema, paginationQuerySchema } from "./pagination";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const board = z.enum(["linkedin", "indeed", "google"]);
const feed = z.enum(["new_grad", "summer_internships"]);
const provider = z.enum([
  "manual",
  "brave",
  "linkedin",
  "indeed",
  "google",
  "new_grad",
  "summer_internships",
]);
const resolutionStatus = z.enum(["unresolved", "resolving", "resolved", "blocked"]);
const candidate = z.object({
  sourceRowId: z.string().min(1).max(300),
  originalUrl: z.url().max(4000),
  candidateDestinationUrl: z.url().max(4000).nullable(),
  titleHint: z.string().trim().min(1).max(500),
  companyHint: z.string().max(300).nullable(),
  locationHint: z.string().max(500).nullable(),
  postedAt: z.iso.datetime({ offset: true }).nullable(),
  sourceDateText: z.string().max(200).nullable(),
});
export type PersonalLeadCandidate = z.infer<typeof candidate>;

export const personalLeadSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    source: provider,
    ...candidate.omit({ postedAt: true }).shape,
    postedAt: z.date().nullable(),
    discoveredAt: z.date(),
    snapshotHash: hash,
    fingerprint: hash,
    fullDescriptionAvailable: z.literal(false),
    employerIdentityVerified: z.literal(false),
    resolution: z
      .object({
        status: resolutionStatus,
        reason: z.string().nullable(),
        officialUrl: z.url().nullable(),
        recordId: z.uuid().nullable(),
        sourceIdentity: z.string().nullable(),
        resolvedAt: z.date().nullable(),
      })
      .strict(),
  })
  .strict();
export type PersonalLead = z.infer<typeof personalLeadSchema>;
export const personalLeadQuerySchema = paginationQuerySchema.extend({
  source: provider.optional(),
  status: resolutionStatus.optional(),
});
export const personalLeadsResponseSchema = paginatedSchema(personalLeadSchema);
export const personalLeadImportSchema = z
  .object({
    candidates: z.array(candidate).min(1).max(200),
  })
  .strict();
export const personalLeadBatchResponseSchema = z
  .object({
    batchId: z.uuid(),
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    status: z.enum(["complete", "partial", "blocked", "failed"]),
    diagnostics: z.array(z.string()),
    nextEligibleAt: z.date().nullable(),
  })
  .strict();
export const personalLeadResolveSchema = z
  .object({
    campaignId: z.uuid(),
    runId: z.uuid(),
    officialUrl: z.url().max(4000).optional(),
  })
  .strict();
export const personalLeadDiscoverSchema = z
  .object({
    board,
    query: z.string().trim().min(1).max(200),
    location: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();
export const personalLeadFeedImportSchema = z
  .object({
    feed,
    format: z.enum(["json", "readme_html"]),
    content: z.string().min(1).max(2_000_000),
    sourceUrl: z.url().max(4000),
    seasonYear: z.number().int().min(2020).max(2100),
    season: z.enum(["summer", "spring", "fall", "winter", "any"]).default("any"),
    maxAgeDays: z.number().int().min(1).max(365).default(120),
  })
  .strict();
export const personalLeadConfigurationSchema = z
  .object({
    boards: z.array(board).max(3).default([]),
    feeds: z.array(feed).max(2).default([]),
  })
  .strict();
