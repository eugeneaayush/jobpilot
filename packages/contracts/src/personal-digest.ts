import { z } from "zod";

const sourceSchema = z.object({
  identity: z.string().max(300),
  configured: z.boolean(),
  health: z.enum([
    "complete",
    "partial",
    "failed",
    "blocked",
    "stale",
    "never_attempted",
    "unknown",
  ]),
  attemptedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  nextEligibleAt: z.date().nullable(),
  observedCount: z.number().int().nonnegative().nullable(),
  expectedTotal: z.number().int().nonnegative().nullable(),
  scope: z.enum(["public_board", "provided_export", "unknown"]),
});
export const personalDigestSchema = z.object({
  schemaVersion: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string(),
  scheduledHour: z.number().int().min(0).max(23),
  capturedAt: z.date(),
  windowStartAt: z.date(),
  windowStartExclusive: z.boolean(),
  delivery: z.literal("local_only"),
  counters: z.object({
    newDiscoveries: z.number().int().nonnegative(),
    prepared: z.number().int().nonnegative(),
    submitted: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  counterBasis: z.literal(
    "New discoveries were created within the reporting window; remaining counters are current record-state totals, not daily transitions.",
  ),
  sourceCoverage: z.object({
    sources: z.array(sourceSchema).max(1000),
    truncated: z.boolean(),
    wholeMarketCoverage: z.literal(false),
    note: z.string(),
  }),
  stoppedCampaigns: z.array(z.object({ id: z.uuid(), name: z.string().max(200) })).max(1000),
  campaignsTruncated: z.boolean(),
  blockers: z
    .array(
      z.object({
        recordId: z.uuid(),
        title: z.string().max(300),
        company: z.string().max(300),
        kinds: z.array(
          z.enum([
            "reconcile_submission",
            "security_handoff",
            "answers_required",
            "render_review",
            "review_block",
            "inspect_failure",
          ]),
        ),
      }),
    )
    .max(100),
  blockersTruncated: z.boolean(),
});
export const personalDigestLatestSchema = z.object({ digest: personalDigestSchema.nullable() });
export const personalDigestTickSchema = z.object({
  status: z.enum(["created", "not_due", "already_created"]),
  digest: personalDigestSchema.nullable(),
});
export type PersonalDigest = z.infer<typeof personalDigestSchema>;
export type PersonalDigestTick = z.infer<typeof personalDigestTickSchema>;
