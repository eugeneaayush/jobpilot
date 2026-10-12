"use client";

import { type ReactElement, useState } from "react";
import type {
  PersonalLead,
  personalLeadBatchResponseSchema,
} from "@jobpilot/contracts/personal-leads";
import {
  Alert,
  Button,
  Divider,
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

type BatchResult = z.infer<typeof personalLeadBatchResponseSchema>;

export function LeadsPanel(): ReactElement {
  const pagination = usePaginationParams({ prefix: "leads", pageSize: 10 });
  const [board, setBoard] = useState<"linkedin" | "indeed" | "google">("linkedin");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const leads = useApiQuery({
    queryKey: [...personalQueryKeys.all, "leads", pagination.query],
    queryFn: () => api.personal.leads.get({ query: pagination.query }),
  });
  const campaigns = useApiQuery(
    personalQueries.campaigns({ page: 1, limit: 100, status: "active" }),
  );
  const campaign = campaigns.data?.items.find((item) => item.id === campaignId);
  const discover = useApiMutation<BatchResult, void>(
    () =>
      api.personal.leads.discover.post({
        board,
        query,
        location: location || undefined,
        limit: 20,
      }),
    { invalidate: [personalQueryKeys.all] },
  );
  const importLead = useApiMutation<BatchResult, void>(
    () =>
      api.personal.leads.import.post({
        candidates: [
          {
            sourceRowId: crypto.randomUUID(),
            originalUrl: url,
            candidateDestinationUrl: url,
            titleHint: title,
            companyHint: null,
            locationHint: null,
            postedAt: null,
            sourceDateText: null,
          },
        ],
      }),
    { invalidate: [personalQueryKeys.all], successMessage: "Unverified lead saved" },
  );
  const runId = campaign?.authorization?.runId;
  // runId rides the variables: the React Compiler reads a closure's `!` paths on every render.
  const resolve = useApiMutation<PersonalLead, { id: string; campaignId: string; runId: string }>(
    ({ id, ...body }) => api.personal.leads({ id }).resolve.post(body),
    { invalidate: [personalQueryKeys.all] },
  );
  return (
    <SectionCard
      title="Discovery leads"
      description="Leads need a current official posting and a registered, campaign-authorized source before they can become application records."
    >
      <Stack spacing={2}>
        <Alert severity="info">
          Optional boards and feeds start disabled. Source configuration and access challenges are
          shown in each result; a lead never grants application authority.
        </Alert>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
          <TextField
            select
            label="Board"
            value={board}
            onChange={(event) => setBoard(event.target.value as typeof board)}
            sx={{ minWidth: 150 }}
          >
            {["linkedin", "indeed", "google"].map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Search terms"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            fullWidth
          />
          <TextField
            label="Location (optional)"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
          <Button disabled={!query.trim() || discover.isPending} onClick={() => discover.mutate()}>
            Find up to 20 leads
          </Button>
        </Stack>
        {discover.data && (
          <Alert severity={discover.data.status === "complete" ? "success" : "warning"}>
            {discover.data.status}: {discover.data.imported} imported.{" "}
            {discover.data.diagnostics.join(" ")}
          </Alert>
        )}
        <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
          <TextField
            label="Lead URL"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            fullWidth
          />
          <TextField
            label="Role title hint"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            fullWidth
          />
          <Button
            disabled={!/^https:\/\//.test(url) || !title.trim() || importLead.isPending}
            onClick={() => importLead.mutate()}
          >
            Save lead
          </Button>
        </Stack>
        <TextField
          select
          label="Campaign for official source resolution"
          value={campaignId}
          onChange={(event) => setCampaignId(event.target.value)}
        >
          <MenuItem value="">Select active campaign</MenuItem>
          {campaigns.data?.items
            .filter((item) => item.authorization)
            .map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {item.name}
              </MenuItem>
            ))}
        </TextField>
        {leads.error && <Alert severity="error">{leads.error.message}</Alert>}
        {leads.data?.items.map((lead) => (
          <Stack key={lead.id} spacing={0.5}>
            <Divider />
            <Link
              href={lead.candidateDestinationUrl ?? lead.originalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {lead.titleHint}
            </Link>
            <Typography variant="body2">
              {lead.companyHint ?? "Employer unverified"} · {lead.source} · {lead.resolution.status}
            </Typography>
            {lead.resolution.reason && (
              <Typography variant="body2Muted">{lead.resolution.reason}</Typography>
            )}
            <Button
              sx={{ alignSelf: "flex-start" }}
              disabled={!runId || resolve.isPending || lead.resolution.status === "resolved"}
              onClick={() => {
                if (runId) resolve.mutate({ id: lead.id, campaignId, runId });
              }}
            >
              Resolve official posting
            </Button>
          </Stack>
        ))}
        {leads.data?.items.length === 0 && (
          <Typography variant="body2Muted">No discovery leads on this page.</Typography>
        )}
        {leads.data && (
          <PaginationFooter
            pagination={leads.data.pagination}
            onPageChange={pagination.setPage}
            onPageSizeChange={pagination.setPageSize}
          />
        )}
      </Stack>
    </SectionCard>
  );
}
