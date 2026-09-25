"use client";

import type { ReactElement } from "react";
import type { personalDigestLatestSchema } from "@jobpilot/contracts/personal-digest";
import { Alert, Chip, Stack, Typography } from "@mui/material";
import type { z } from "zod/v4";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { EmptyState } from "@/components/ui/data";
import { ColorChip, LabelValue, RelativeTime } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";

type DigestEnvelope = z.infer<typeof personalDigestLatestSchema>;
type Digest = NonNullable<DigestEnvelope["digest"]>;

const HEALTH_COLOR: Record<
  Digest["sourceCoverage"]["sources"][number]["health"],
  "success" | "warning" | "error" | "default"
> = {
  complete: "success",
  partial: "warning",
  failed: "error",
  blocked: "error",
  stale: "warning",
  never_attempted: "default",
  unknown: "default",
};

const BLOCKER_LABEL: Record<Digest["blockers"][number]["kinds"][number], string> = {
  reconcile_submission: "Reconcile submission",
  security_handoff: "Security handoff",
  answers_required: "Answers required",
  render_review: "Render review",
  review_block: "Review block",
  inspect_failure: "Inspect failure",
};

function isStale(digest: Digest): boolean {
  const captured = new Date(digest.capturedAt).getTime();
  return Number.isFinite(captured) && Date.now() - captured > 26 * 60 * 60_000;
}

/** Eden revives date-shaped strings, so `day` may arrive as a Date; normalize to YYYY-MM-DD. */
function dayLabel(day: string | Date): string {
  return typeof day === "string" ? day : day.toISOString().slice(0, 10);
}

/**
 * Read-only local daily digest. It is computed from this account's own data and states its
 * basis; it never claims whole-market coverage, and no tick is ever triggered from here.
 */
export function DigestPanel(): ReactElement {
  const digestQuery = useApiQuery(personalQueries.digest());
  const digest = digestQuery.data?.digest ?? null;

  return (
    <SectionCard
      title="Daily digest"
      description="Yesterday at a glance, from this account's records only — delivered locally."
    >
      <Stack spacing={2}>
        {digestQuery.isLoading ? (
          <Typography variant="body2Muted">Loading the digest…</Typography>
        ) : digestQuery.isError ? (
          <Alert severity="error">
            Couldn&apos;t load the digest — retry from the page or check the API.
          </Alert>
        ) : !digest ? (
          <EmptyState
            variant="inline"
            title="No digest yet."
            description="A digest appears here once one has been captured for a day; none is created from this page."
          />
        ) : (
          <Stack spacing={2}>
            {isStale(digest) && (
              <Alert severity="warning">
                This digest is stale — captured more than a day ago. Numbers reflect that capture,
                not live state.
              </Alert>
            )}
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              <Chip size="small" variant="outlined" label={`day ${dayLabel(digest.day)}`} />
              <Chip size="small" variant="outlined" label={digest.timezone} />
              <Chip size="small" variant="outlined" label="local only" />
            </Stack>
            <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", gap: 2 }}>
              {/* String() so LabelValue gives each counter its own body2 element. */}
              <LabelValue label="New discoveries">
                {String(digest.counters.newDiscoveries)}
              </LabelValue>
              <LabelValue label="Prepared">{String(digest.counters.prepared)}</LabelValue>
              <LabelValue label="Submitted">{String(digest.counters.submitted)}</LabelValue>
              <LabelValue label="Uncertain">{String(digest.counters.uncertain)}</LabelValue>
              <LabelValue label="Blocked">{String(digest.counters.blocked)}</LabelValue>
              <LabelValue label="Failed">{String(digest.counters.failed)}</LabelValue>
            </Stack>
            <Typography variant="captionMuted">{digest.counterBasis}</Typography>
            <LabelValue label="Captured">
              <RelativeTime value={digest.capturedAt} variant="body2" />
            </LabelValue>

            <Stack spacing={1}>
              <Typography variant="overlineMuted">Source coverage</Typography>
              {digest.sourceCoverage.sources.length === 0 ? (
                <Typography variant="body2Muted">No sources reported in this window.</Typography>
              ) : (
                digest.sourceCoverage.sources.map((source) => (
                  <Stack
                    key={source.identity}
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                  >
                    <ColorChip
                      value={source.health}
                      colors={HEALTH_COLOR}
                      label={source.health.replaceAll("_", " ")}
                      variant="outlined"
                    />
                    <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                      {source.identity}
                    </Typography>
                    {source.observedCount !== null && (
                      <Typography variant="captionMuted">
                        {source.expectedTotal !== null
                          ? `${source.observedCount}/${source.expectedTotal} observed`
                          : `${source.observedCount} observed`}
                      </Typography>
                    )}
                    {source.completedAt && <RelativeTime value={source.completedAt} />}
                  </Stack>
                ))
              )}
              <Typography variant="captionMuted">
                Coverage is the registered sources above only — not the whole market.
                {digest.sourceCoverage.truncated ? " Source list truncated." : ""}
              </Typography>
            </Stack>

            {digest.blockers.length > 0 ? (
              <Stack spacing={1}>
                <Typography variant="overlineMuted">Action blockers</Typography>
                {digest.blockers.map((blocker) => (
                  <Stack
                    key={blocker.recordId}
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                  >
                    <Typography variant="body2">
                      {blocker.title} · {blocker.company}
                    </Typography>
                    {blocker.kinds.map((kind) => (
                      <Chip
                        key={kind}
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={BLOCKER_LABEL[kind]}
                      />
                    ))}
                  </Stack>
                ))}
                {digest.blockersTruncated && (
                  <Typography variant="captionMuted">Blocker list truncated.</Typography>
                )}
              </Stack>
            ) : (
              <Typography variant="body2Muted">No action blockers recorded.</Typography>
            )}
          </Stack>
        )}
      </Stack>
    </SectionCard>
  );
}
