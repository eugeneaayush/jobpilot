"use client";

import type { ReactElement } from "react";
import { Button, Grid, LinearProgress, Stack, Typography } from "@mui/material";
import { useSearchParams } from "next/navigation";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { usePaginationParams } from "@/hooks/use-pagination";
import { ActivityPanel } from "./activity-panel";
import { CampaignCard } from "./campaign-card";
import { CapabilityBanner } from "./capability-banner";
import { DigestPanel } from "./digest-panel";
import { DiscoverCard } from "./discover-card";
import { isPersonalTrack } from "./personal-labels";
import { ReadinessPanel } from "./readiness-panel";
import { RecordsTable } from "./records-table";
import { RecruitingPanel } from "./recruiting-panel";
import { RegistryPanel } from "./registry-panel";
import { ResumeIntakeCard } from "./resume-intake-card";
import { SearchPanel } from "./search-panel";
import { SettingsForm } from "./settings-form";
import { SourcesPanel } from "./sources-panel";

/** Private intake, discovery, offline previews, and explicitly authorized campaign controls. */
export function PersonalDashboard(): ReactElement {
  const pagination = usePaginationParams({ pageSize: 10 });
  const trackParam = useSearchParams().get("track");
  const track = isPersonalTrack(trackParam) ? trackParam : null;

  const dashboard = useApiQuery(
    personalQueries.dashboard({ ...pagination.query, ...(track && { track }) }),
  );

  if (dashboard.isLoading) {
    return <LinearProgress />;
  }

  // Silently spinning forever is the failure mode this rules out.
  if (!dashboard.data) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="body2Muted">Couldn&apos;t load the personal dashboard.</Typography>
        <Button variant="text" size="small" onClick={() => void dashboard.refetch()}>
          Retry
        </Button>
      </Stack>
    );
  }

  const { capabilities, sources, resume, records } = dashboard.data;

  return (
    <Stack spacing={2.5}>
      <CapabilityBanner capabilities={capabilities} />
      <RecruitingPanel />
      <ReadinessPanel />
      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <ResumeIntakeCard resume={resume} intakeEnabled={capabilities.personalMode} />
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          <SourcesPanel sources={sources} />
        </Grid>
      </Grid>
      <DiscoverCard discoverEnabled={capabilities.personalMode} />
      <SearchPanel />
      <RegistryPanel />
      <DigestPanel />
      <CampaignCard />
      <ActivityPanel activity={dashboard.data.activity} supervisor={dashboard.data.supervisor} />
      <RecordsTable
        records={records.items}
        paginationMeta={records.pagination}
        loading={dashboard.isFetching}
        offlinePreview={capabilities.offlinePreview}
        pagination={pagination}
        track={track}
        onTrackChange={(next) => pagination.setFilters({ track: next })}
      />
      <SettingsForm />
    </Stack>
  );
}
