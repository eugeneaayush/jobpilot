"use client";

import { type ReactElement, useState } from "react";
import type {
  PersonalBatch,
  personalBatchSuggestionsSchema,
} from "@jobpilot/contracts/personal-batch";
import {
  Alert,
  Button,
  Chip,
  Divider,
  LinearProgress,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { z } from "zod/v4";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueries, personalQueryKeys } from "@/api/personal";
import { PaginationFooter } from "@/components/ui/data";
import { SectionCard } from "@/components/ui/layout";
import { usePaginationParams } from "@/hooks/use-pagination";
import { TRACK_LABEL } from "./personal-labels";

type Suggestions = z.infer<typeof personalBatchSuggestionsSchema>;
const PHASE_LABEL = {
  propose: "Tailoring proposal",
  claim_review: "Claim review",
  preview: "Document preparation",
  render_review: "Visual review",
  complete: "Document work complete",
} as const;

export function BatchesPanel(): ReactElement {
  const [campaignId, setCampaignId] = useState("");
  const pagination = usePaginationParams({ prefix: "batches", pageSize: 10 });
  const batches = useApiQuery({
    queryKey: [...personalQueryKeys.all, "batches", pagination.query],
    queryFn: () => api.personal.batches.get({ query: pagination.query }),
  });
  const campaigns = useApiQuery(
    personalQueries.campaigns({ page: 1, limit: 100, status: "active" }),
  );
  const suggestions = useApiMutation<Suggestions, string>((id) =>
    api.personal.batches.suggest.post({ campaignId: id }),
  );
  const create = useApiMutation<PersonalBatch, string[]>(
    (recordIds) => api.personal.batches.post({ campaignId, recordIds }),
    {
      invalidate: [personalQueryKeys.all],
      successMessage:
        "Shared analysis saved. Each application keeps its own documents and approval.",
      onSuccess: () => suggestions.reset(),
    },
  );
  const advance = useApiMutation<PersonalBatch, { id: string; hash: string; retry: boolean }>(
    (input) =>
      api.personal
        .batches({ id: input.id })
        .advance.post({ expectedAnalysisHash: input.hash, retryBlocked: input.retry }),
    { invalidate: [personalQueryKeys.all] },
  );

  return (
    <SectionCard
      title="Batch tailoring"
      description="Share gap analysis across 3–5 related roles, while preparing and reviewing each application separately."
    >
      <Stack spacing={2}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ alignItems: { sm: "center" } }}
        >
          <TextField
            select
            fullWidth
            label="Active campaign"
            value={campaignId}
            onChange={(event) => {
              setCampaignId(event.target.value);
              suggestions.reset();
            }}
          >
            <MenuItem value="">Select a campaign</MenuItem>
            {campaigns.data?.items.map((campaign) => (
              <MenuItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </MenuItem>
            ))}
          </TextField>
          <Button
            disabled={!campaignId || suggestions.isPending || create.isPending}
            onClick={() => suggestions.mutate(campaignId)}
          >
            Suggest related roles
          </Button>
        </Stack>
        {campaigns.error && <Alert severity="error">{campaigns.error.message}</Alert>}
        {suggestions.isPending && <LinearProgress />}
        {suggestions.error && <Alert severity="error">{suggestions.error.message}</Alert>}
        {suggestions.data && suggestions.data.suggestions.length === 0 && (
          <Typography variant="body2Muted">
            No related groups among the {suggestions.data.examined} records examined. Each pair
            needs at least 60% keyword overlap and current source evidence.
          </Typography>
        )}
        {suggestions.data?.suggestions.map((suggestion) => (
          <Stack key={suggestion.recordIds.join(":")} spacing={1}>
            <Typography variant="subtitle2">
              {TRACK_LABEL[suggestion.track]} · {suggestion.recordIds.length} roles ·{" "}
              {Math.round(suggestion.minimumOverlap * 100)}% minimum overlap
            </Typography>
            {suggestion.roles.map((role) => (
              <Typography key={role.recordId} variant="body2">
                {role.title} — {role.company}
              </Typography>
            ))}
            <Button
              size="small"
              sx={{ alignSelf: "flex-start" }}
              disabled={create.isPending}
              onClick={() => create.mutate(suggestion.recordIds)}
            >
              Analyze these {suggestion.recordIds.length} roles
            </Button>
          </Stack>
        ))}
        {create.error && <Alert severity="error">{create.error.message}</Alert>}
        {batches.isLoading && <LinearProgress />}
        {batches.error && (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void batches.refetch()}>
                Retry
              </Button>
            }
          >
            {batches.error.message}
          </Alert>
        )}
        {batches.data?.items.length === 0 && (
          <Typography variant="body2Muted">No shared tailoring analyses yet.</Typography>
        )}
        {batches.data?.items.map((batch) => (
          <Stack key={batch.id} spacing={1}>
            <Divider />
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Typography variant="subtitle2">
                {TRACK_LABEL[batch.analysis.track]} · {batch.members.length} roles
              </Typography>
              <Chip
                size="small"
                label={batch.status}
                color={batch.status === "stale" ? "warning" : "default"}
              />
            </Stack>
            {batch.analysis.members.map((role) => {
              const state = batch.members.find((member) => member.recordId === role.recordId);
              return (
                <Stack key={role.recordId} spacing={0.5}>
                  <Typography variant="body2">
                    {role.title} — {role.company}
                  </Typography>
                  <Typography variant="captionMuted">
                    {state?.status} ·{" "}
                    {state?.phase ? PHASE_LABEL[state.phase] : "Preparation pending"}
                    {state?.reason ? ` · ${state.reason}` : ""}
                  </Typography>
                </Stack>
              );
            })}
            <Typography variant="body2Muted">
              Shared supported terms: {batch.analysis.sharedSupportedTerms.join(", ") || "None"}
            </Typography>
            {batch.sourceQuestion && (
              <Alert severity="info">
                <Stack spacing={0.5}>
                  <Typography variant="body2">{batch.sourceQuestion.prompt}</Typography>
                  {batch.sourceQuestion.answer && (
                    <Typography variant="body2">
                      Response for source review: {batch.sourceQuestion.answer}
                    </Typography>
                  )}
                  {batch.sourceQuestion.status === "open" && (
                    <Link href="/pilot">Answer the shared source question in Pilot</Link>
                  )}
                  {batch.sourceQuestion.status === "answered" && (
                    <Typography variant="caption">
                      Accept any new facts through the source review workflow, then create a new
                      batch. This response has not changed the resume.
                    </Typography>
                  )}
                </Stack>
              </Alert>
            )}
            {batch.staleReason && <Alert severity="warning">{batch.staleReason}</Alert>}
            {batch.running && (
              <Typography variant="body2Muted">A preparation checkpoint is running.</Typography>
            )}
            {batch.status === "active" && (
              <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
                <Button
                  size="small"
                  disabled={batch.running || advance.isPending}
                  onClick={() =>
                    advance.mutate({ id: batch.id, hash: batch.analysisHash, retry: false })
                  }
                >
                  Advance document preparation
                </Button>
                {batch.members.some(
                  (member) => member.status === "blocked" && member.phase !== "complete",
                ) && (
                  <Button
                    size="small"
                    disabled={batch.running || advance.isPending}
                    onClick={() =>
                      advance.mutate({ id: batch.id, hash: batch.analysisHash, retry: true })
                    }
                  >
                    Retry held member
                  </Button>
                )}
              </Stack>
            )}
          </Stack>
        ))}
        {advance.isPending && <LinearProgress />}
        {advance.error && <Alert severity="error">{advance.error.message}</Alert>}
        {batches.data && (
          <PaginationFooter
            pagination={batches.data.pagination}
            onPageChange={pagination.setPage}
            onPageSizeChange={pagination.setPageSize}
          />
        )}
      </Stack>
    </SectionCard>
  );
}
