"use client";

import { type ReactElement, useState } from "react";
import type { personalSearchResponseSchema } from "@jobpilot/contracts/personal-search";
import { Search } from "@mui/icons-material";
import { Alert, Button, Chip, MenuItem, Stack, TextField, Typography } from "@mui/material";
import type { z } from "zod/v4";
import { api } from "@/api/client";
import { useApiMutation } from "@/api/hooks";
import { personalQueryKeys } from "@/api/personal";
import { ColorChip, ExternalLink } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";
import { plural } from "@/utils/format";

type SearchResponse = z.infer<typeof personalSearchResponseSchema>;

const PAGE_OPTIONS = [1, 3, 5, 10] as const;
const SIZE_OPTIONS = [10, 20] as const;

/** Manual-only: no automatic calls, no polling, no spend without an explicit click. */
export function SearchPanel(): ReactElement {
  const [query, setQuery] = useState("");
  const [maxPages, setMaxPages] = useState<number>(3);
  const [pageSize, setPageSize] = useState<number>(20);

  const search = useApiMutation<
    SearchResponse,
    { query: string; maxPages: number; pageSize: number }
  >((body) => api.personal.search.post(body), { invalidate: [personalQueryKeys.all] });

  const data = search.data ?? null;
  const status = data?.status ?? null;

  return (
    <SectionCard
      title="Search candidates"
      description="Manual web search for career-page URL candidates. Results are unverified search snippets — never jobs, eligibility verdicts, or ready roles."
    >
      <Stack spacing={2}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          sx={{ alignItems: { xs: "stretch", md: "center" } }}
        >
          <TextField
            label="Search query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            helperText="Up to 600 characters; one manual search per click."
            fullWidth
          />
          <TextField
            select
            label="Pages"
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            sx={{ minWidth: 110 }}
          >
            {PAGE_OPTIONS.map((pages) => (
              <MenuItem key={pages} value={pages}>
                {pages}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Page size"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            sx={{ minWidth: 110 }}
          >
            {SIZE_OPTIONS.map((size) => (
              <MenuItem key={size} value={size}>
                {size}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            startIcon={<Search fontSize="sm" />}
            disabled={query.trim().length === 0 || search.isPending}
            onClick={() => search.mutate({ query: query.trim(), maxPages, pageSize })}
          >
            Search
          </Button>
        </Stack>

        {status === "missing_setup" && (
          <Alert severity="warning">
            Search is not set up for this account yet. {data?.reasons.join(" ") || ""}
          </Alert>
        )}
        {status === "budget_exhausted" && (
          <Alert severity="warning">
            The reserved search budget for this month is exhausted. No request was made.
          </Alert>
        )}
        {status === "cooldown" && (
          <Alert severity="info">
            Search is cooling down until the next eligible time. No request was made.
          </Alert>
        )}
        {status === "failed" && (
          <Alert severity="error">The search failed. {data?.reasons.join(" ") || ""}</Alert>
        )}
        {status === "blocked" && (
          <Alert severity="error">The search was blocked. {data?.reasons.join(" ") || ""}</Alert>
        )}
        {status === "partial" && (
          <Alert severity="warning">
            Partial results — some pages failed or were refused. {data?.reasons.join(" ") || ""}
          </Alert>
        )}

        {data && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              <ColorChip
                value={data.status}
                colors={{
                  complete: "success",
                  partial: "warning",
                  cooldown: "info",
                  missing_setup: "warning",
                  budget_exhausted: "warning",
                  blocked: "error",
                  failed: "error",
                }}
                label={data.status.replaceAll("_", " ")}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`scope: ${data.coverage.scope} — this query only`}
              />
              {data.budget && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`reserved $${(data.budget.searchReservedMicrousd / 1_000_000).toFixed(2)} of $${(data.budget.searchLimitMicrousd / 1_000_000).toFixed(2)} search / $${(data.budget.monthlyLimitMicrousd / 1_000_000).toFixed(2)} monthly (local reservations)`}
                />
              )}
            </Stack>
            <Typography variant="captionMuted">
              Coverage is exactly this search query's responses — never the whole web, and the
              provider's actual bill is unknown to JobPilot.
            </Typography>
            <Typography variant="body2">
              {data.coverage.observedCount} observed · {data.coverage.invalidCount} invalid ·{" "}
              {data.coverage.duplicateCount} duplicates · {plural(data.receipts.length, "page")}{" "}
              fetched
            </Typography>
            {data.candidates.map((candidate) => (
              <Stack
                key={candidate.urlHash}
                spacing={0.5}
                sx={(theme) => ({
                  border: 1,
                  borderColor: theme.palette.line.border,
                  borderRadius: theme.radii.md,
                  p: 1.5,
                })}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Chip size="small" variant="outlined" label={`page ${candidate.page}`} />
                  <ExternalLink href={candidate.url} truncateTo={420}>
                    {candidate.title}
                  </ExternalLink>
                </Stack>
                {candidate.snippet && (
                  <Typography variant="captionMuted" sx={{ wordBreak: "break-word" }}>
                    {candidate.snippet}
                  </Typography>
                )}
                <Typography variant="captionMuted">
                  Unverified snippet — no full description fetched, employer identity unverified.
                </Typography>
              </Stack>
            ))}
            {data.candidates.length === 0 && status !== "missing_setup" && (
              <Typography variant="body2Muted">No candidates returned for this query.</Typography>
            )}
          </Stack>
        )}
      </Stack>
    </SectionCard>
  );
}
