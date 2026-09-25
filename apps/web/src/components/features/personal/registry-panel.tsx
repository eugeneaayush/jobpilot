"use client";

import type { ReactNode } from "react";
import { type ReactElement, useState } from "react";
import type {
  personalRegistryAliasesSchema,
  personalRegistryResponseSchema,
} from "@jobpilot/contracts/personal-registry";
import { Alert, Chip, Stack, Typography } from "@mui/material";
import type { z } from "zod/v4";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { EmptyState, PaginationFooter } from "@/components/ui/data";
import { ColorChip, LabelValue, RelativeTime } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";

type RegistrySource = z.infer<typeof personalRegistryResponseSchema>["sources"][number];
type Alias = z.infer<typeof personalRegistryAliasesSchema>["aliases"][number];

const PAGE_SIZE = 25;

const DISCOVERY_LABEL: Record<RegistrySource["adapter"]["discovery"], string> = {
  public_api: "Public API discovery",
  import_only: "Import only",
  unsupported: "Unsupported",
};

const SUBMISSION_TEXT: Record<
  RegistrySource["adapter"]["submission"],
  { label: string; note: string }
> = {
  guarded_greenhouse: {
    label: "Guarded Greenhouse submit",
    note: "",
  },
  restricted_lever: {
    label: "Restricted Lever submit (verified native multipart only)",
    note: " — custom widgets and unsupported flows park; even an HTTP 2xx stays uncertain until reconciled",
  },
  unsupported: {
    label: "No submit adapter",
    note: " — records park as adapter-required, never silently skipped",
  },
};

function submissionText(submission: RegistrySource["adapter"]["submission"]): {
  label: string;
  note: string;
} {
  return SUBMISSION_TEXT[submission];
}

const HEALTH_COLOR: Record<
  RegistrySource["status"] extends infer T ? (T extends string ? T : never) : never,
  "success" | "warning" | "error" | "default"
> = {
  complete: "success",
  partial: "warning",
  failed: "error",
  blocked: "error",
};

/**
 * Read-only registry and policy view: what is registered, what each adapter can honestly do,
 * and the locally-tracked run policy. No registration or alias editing happens here.
 */
export function RegistryPanel(): ReactElement {
  // Local page state only: this panel rides the dashboard, not a routed list of its own.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [aliasPage, setAliasPage] = useState(1);
  const registry = useApiQuery(personalQueries.registry({ page, limit: pageSize }));
  const aliases = useApiQuery(personalQueries.aliases({ page: aliasPage, limit: pageSize }));
  const policy = useApiQuery(personalQueries.policy());

  return (
    <SectionCard
      title="Source registry"
      description="Registered boards, their honest adapter capabilities, and the locally-tracked run policy."
    >
      <Stack spacing={2}>
        {registry.isLoading ? (
          <Typography variant="body2Muted">Loading the registry…</Typography>
        ) : registry.isError ? (
          <Alert severity="error">
            Couldn&apos;t load the registry — retry from the page or check the API.
          </Alert>
        ) : (registry.data?.sources.length ?? 0) === 0 ? (
          <EmptyState
            variant="inline"
            title="No registered sources yet."
            description="Sources appear here once a board is registered for discovery."
          />
        ) : (
          <Stack spacing={1.5}>
            {registry.data?.sources.map((source) => (
              <Stack
                key={source.id}
                spacing={1}
                sx={(theme) => ({
                  border: 1,
                  borderColor: theme.palette.line.border,
                  borderRadius: theme.radii.md,
                  p: 1.5,
                })}
              >
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                >
                  <Chip
                    size="small"
                    variant="outlined"
                    label={source.configuration?.source ?? "unconfigured"}
                  />
                  <Typography variant="body2Strong" sx={{ wordBreak: "break-all" }}>
                    {source.identity}
                  </Typography>
                  {source.status && (
                    <ColorChip
                      value={source.status}
                      colors={HEALTH_COLOR}
                      label={source.status}
                      variant="outlined"
                    />
                  )}
                  {source.configurationState === "invalid" && (
                    <Chip
                      size="small"
                      color="error"
                      variant="outlined"
                      label="configuration invalid"
                    />
                  )}
                </Stack>
                <Typography variant="captionMuted">
                  {DISCOVERY_LABEL[source.adapter.discovery]} ·{" "}
                  {submissionText(source.adapter.submission).label}
                  {submissionText(source.adapter.submission).note}
                </Typography>
                <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", gap: 2 }}>
                  {source.lastSuccessfulAt && (
                    <LabelValue label="Last success">
                      <RelativeTime value={source.lastSuccessfulAt} variant="body2" />
                    </LabelValue>
                  )}
                  {source.nextEligibleAt && (
                    <LabelValue label="Next eligible">
                      <RelativeTime value={source.nextEligibleAt} variant="body2" />
                    </LabelValue>
                  )}
                </Stack>
              </Stack>
            ))}
            {registry.data && (
              <PaginationFooter
                pagination={registry.data.pagination}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            )}
          </Stack>
        )}

        {policy.data ? (
          <Stack spacing={1}>
            <Typography variant="overlineMuted">Run policy (read-only)</Typography>
            <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", gap: 2 }}>
              <LabelValue label="Daily cap">{policy.data.dailyCap}</LabelValue>
              <LabelValue label="Active per employer">{policy.data.employerActiveCap}</LabelValue>
              <LabelValue label="Monthly budget">
                ${(policy.data.monthlyBudgetCents / 100).toFixed(2)}
              </LabelValue>
              <LabelValue label="Search budget">
                ${(policy.data.searchBudgetCents / 100).toFixed(2)}
              </LabelValue>
            </Stack>
            <Typography variant="captionMuted">
              Locally tracked reservations against plan ceilings (daily 50, 3 per employer, $200.00
              monthly, $50.00 search); adjustment is downward-only and never claims the
              provider&apos;s actual bill.
            </Typography>
          </Stack>
        ) : (
          policy.isError && <Alert severity="warning">Couldn&apos;t load the run policy.</Alert>
        )}

        <AliasesSection state={aliases} onPageChange={setAliasPage} />
      </Stack>
    </SectionCard>
  );
}

interface AliasesSectionProps {
  state: ReturnType<typeof useApiQuery<z.infer<typeof personalRegistryAliasesSchema>>>;
  onPageChange: (page: number) => void;
}

const VERIFICATION_LABEL: Record<Alias["verification"], string> = {
  owner_attested: "Owner attested",
  legacy_unverified: "Legacy unverified",
};

const VERIFICATION_COLOR: Record<Alias["verification"], "success" | "default"> = {
  owner_attested: "success",
  legacy_unverified: "default",
};

/** Read-only employer aliases; attestation is a separate, explicitly permitted flow. */
function AliasesSection(props: AliasesSectionProps): ReactNode {
  const { state, onPageChange } = props;

  return (
    <Stack spacing={1}>
      <Typography variant="overlineMuted">Employer aliases (read-only)</Typography>
      {state.isLoading ? (
        <Typography variant="body2Muted">Loading aliases…</Typography>
      ) : state.isError ? (
        <Alert severity="warning">Couldn&apos;t load employer aliases.</Alert>
      ) : (state.data?.aliases.length ?? 0) === 0 ? (
        <Typography variant="body2Muted">No employer aliases registered yet.</Typography>
      ) : (
        <Stack spacing={1}>
          {state.data?.aliases.map((alias) => (
            <Stack
              key={alias.id}
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
            >
              <ColorChip
                value={alias.verification}
                colors={VERIFICATION_COLOR}
                label={VERIFICATION_LABEL[alias.verification]}
                variant="outlined"
              />
              <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                {alias.sourceIdentity}
              </Typography>
              <Typography variant="captionMuted">→</Typography>
              <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                {alias.canonicalEmployer}
              </Typography>
              <RelativeTime value={alias.createdAt} />
            </Stack>
          ))}
          {state.data && state.data.pagination.totalPages > 1 && (
            <PaginationFooter pagination={state.data.pagination} onPageChange={onPageChange} />
          )}
        </Stack>
      )}
      <Typography variant="captionMuted">
        Aliases link a board identity to one canonical employer; replacement is blocked after any
        attempt or reservation. Registration is not done from this page.
      </Typography>
    </Stack>
  );
}
