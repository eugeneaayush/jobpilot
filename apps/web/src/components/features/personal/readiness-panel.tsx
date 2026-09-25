"use client";

import type { ReactElement } from "react";
import type { PersonalReadiness } from "@jobpilot/contracts/personal-readiness";
import { Alert, Chip, Grid, Stack, Typography } from "@mui/material";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { EmptyState } from "@/components/ui/data";
import { LabelValue, RelativeTime } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";

const SCOPE_LABEL = {
  none: "No provider access",
  metadata_only: "Metadata only",
  applicant_data: "Applicant data",
} as const;

const SCOPE_COLOR = {
  none: "error",
  metadata_only: "warning",
  applicant_data: "success",
} as const;

const SCOPE_EXPLANATION = {
  none: "Live workers have no verified provider scope. Offline mock previews remain available.",
  metadata_only:
    "The model receives opaque field references and action status. The local broker can fill approved answers and submit within an authorized campaign; applicant values and documents stay out of model input.",
  applicant_data:
    "The provider is approved to handle your applicant data under the campaign policy.",
} as const;

const RESUME_LABEL = {
  missing: "Missing",
  conflicted: "Conflicted",
  ready: "Intake complete",
} as const;
const RESUME_COLOR = { missing: "error", conflicted: "warning", ready: "success" } as const;

function ReadinessRows(props: { readiness: PersonalReadiness }): ReactElement {
  const { readiness } = props;
  const { terminal, providerApproval, resume } = readiness;
  const campaignQuestions = readiness.missingSettings.filter((s) => s.scope === "campaign");
  const perJobQuestions = readiness.missingSettings.filter((s) => s.scope === "per_job");

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Chip
          size="small"
          color={readiness.campaignExecutionReady ? "success" : "default"}
          variant="outlined"
          label={readiness.campaignExecutionReady ? "Setup ready" : "Setup not ready"}
        />
        <Chip
          size="small"
          color={SCOPE_COLOR[providerApproval.scope]}
          label={`Provider scope: ${SCOPE_LABEL[providerApproval.scope]}`}
        />
        <Chip
          size="small"
          variant="outlined"
          color={terminal.codexSupervisorEnabled ? "success" : "warning"}
          label={terminal.codexSupervisorEnabled ? "Supervisor enabled" : "Supervisor not enabled"}
        />
        <Chip
          size="small"
          variant="outlined"
          color={RESUME_COLOR[resume.status]}
          label={`Resume: ${RESUME_LABEL[resume.status]}`}
        />
      </Stack>
      <Typography variant="captionMuted">
        Setup readiness checks account and provider configuration only — per-job eligibility,
        screening answers, and document render reviews still apply to every record before it runs.
      </Typography>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <LabelValue label="Provider scope">
            <Stack spacing={0.5}>
              <Typography variant="body2">{SCOPE_LABEL[providerApproval.scope]}</Typography>
              <Typography variant="captionMuted">
                {SCOPE_EXPLANATION[providerApproval.scope]}
              </Typography>
            </Stack>
          </LabelValue>
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <LabelValue label="Supervisor">
            <Stack spacing={0.5}>
              <Typography variant="body2">{terminal.status}</Typography>
              {terminal.blockReason && (
                <Typography variant="captionMuted">{terminal.blockReason}</Typography>
              )}
              <Typography variant="captionMuted">
                structured tasks {terminal.structuredTasks ? "on" : "off"} · broker{" "}
                {terminal.brokerConfigured ? "configured" : "unconfigured"} · mock{" "}
                {terminal.mock ? "available" : "unavailable"}
              </Typography>
              <Typography variant="captionMuted">
                {terminal.providers
                  .map(
                    (p) => `${p.id} ${p.installed ? (p.version ?? "installed") : "not installed"}`,
                  )
                  .join(" · ")}
              </Typography>
            </Stack>
          </LabelValue>
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <LabelValue label="Resume intake">
            <Stack spacing={0.5}>
              <Typography variant="body2">{RESUME_LABEL[resume.status]}</Typography>
              {resume.sourceHash && (
                <Typography variant="captionMuted" sx={{ wordBreak: "break-all" }}>
                  {resume.sourceHash.slice(0, 12)}
                </Typography>
              )}
              {resume.conflicts.map((conflict) => (
                <Typography key={conflict} variant="captionMuted">
                  {conflict}
                </Typography>
              ))}
            </Stack>
          </LabelValue>
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <LabelValue label="Checked">
            <RelativeTime value={readiness.checkedAt} variant="body2" />
          </LabelValue>
        </Grid>
      </Grid>

      <Stack spacing={1}>
        <Typography variant="overlineMuted">Global setup blockers</Typography>
        {readiness.blockers.length === 0 && campaignQuestions.length === 0 ? (
          <Typography variant="body2Muted">None — global setup is complete.</Typography>
        ) : (
          <Stack spacing={1}>
            {readiness.blockers.map((blocker) => (
              <Alert key={blocker} severity="error">
                {blocker}
              </Alert>
            ))}
            {campaignQuestions.map((question) => (
              <Alert key={question.field} severity="warning">
                {question.field}: {question.reason}
              </Alert>
            ))}
          </Stack>
        )}
      </Stack>

      <Stack spacing={1}>
        <Typography variant="overlineMuted">Per-job questions</Typography>
        {perJobQuestions.length === 0 && readiness.browser.status !== "needs_per_job" ? (
          <Typography variant="body2Muted">None pending.</Typography>
        ) : (
          <Stack spacing={1}>
            {perJobQuestions.map((question) => (
              <Alert key={question.field} severity="info">
                {question.field}: {question.reason}
              </Alert>
            ))}
            {readiness.browser.status === "needs_per_job" && (
              <Alert severity="info">Browser step is per-job: {readiness.browser.reason}</Alert>
            )}
            <Typography variant="captionMuted">
              Answer these per record with the Answers action in the records table.
            </Typography>
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

/**
 * Verified execution readiness: what blocks every run globally, versus what only a
 * specific job's screening flow needs. Absent states are stated, never hidden.
 */
export function ReadinessPanel(): ReactElement {
  const readiness = useApiQuery(personalQueries.readiness());

  return (
    <SectionCard
      title="Execution readiness"
      description="What is verified before any run can execute — global setup first, per-job questions second."
    >
      {readiness.isLoading ? (
        <Typography variant="body2Muted" sx={{ py: 2 }}>
          Checking readiness…
        </Typography>
      ) : readiness.data ? (
        <ReadinessRows readiness={readiness.data} />
      ) : (
        <EmptyState
          variant="inline"
          title="Couldn't load readiness."
          description="Retry from the page, or check the API is reachable."
        />
      )}
    </SectionCard>
  );
}
