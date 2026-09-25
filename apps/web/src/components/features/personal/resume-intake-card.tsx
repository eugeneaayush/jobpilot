"use client";

import type { ReactElement } from "react";
import type { PersonalDashboard } from "@jobpilot/contracts/personal";
import { Input } from "@mui/icons-material";
import { Alert, Button, Stack, Typography } from "@mui/material";
import { api } from "@/api/client";
import { useApiMutation } from "@/api/hooks";
import { personalQueryKeys } from "@/api/personal";
import { EmptyState } from "@/components/ui/data";
import { CopyField, LabelValue, RelativeTime } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";

interface ResumeIntakeCardProps {
  resume: PersonalDashboard["resume"];
  /** Intake writes through the API; personal mode off means the button can only fail. */
  intakeEnabled: boolean;
}

/** The configured resume: verbatim import, original-file hash, and factual conflicts. */
export function ResumeIntakeCard(props: ResumeIntakeCardProps): ReactElement {
  const { resume, intakeEnabled } = props;

  const intake = useApiMutation(() => api.personal.intake.post(), {
    successMessage: "Resume imported",
    invalidate: [personalQueryKeys.all],
  });

  return (
    <SectionCard
      title="Resume"
      description="Imported from your configured local source — the original file hash is kept."
      actions={
        <Button
          size="small"
          variant="outlined"
          startIcon={<Input fontSize="sm" />}
          disabled={!intakeEnabled || intake.isPending}
          onClick={() => intake.mutate()}
        >
          {resume ? "Re-import" : "Import resume"}
        </Button>
      }
    >
      {!intakeEnabled ? (
        <EmptyState
          variant="inline"
          title="Intake unavailable."
          description="Personal mode is off, so the configured source cannot be imported."
        />
      ) : !resume ? (
        <EmptyState
          variant="inline"
          title="No resume imported yet."
          description="Import the configured local source to score and prepare records."
        />
      ) : (
        <Stack spacing={2}>
          <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", gap: 2 }}>
            <LabelValue label="Resume">{resume.label}</LabelValue>
            <LabelValue label="Imported">
              <RelativeTime value={resume.createdAt} variant="body2" />
            </LabelValue>
          </Stack>
          <LabelValue label="Source hash">
            <CopyField value={resume.sourceHash} ariaLabel="Copy source hash" />
          </LabelValue>
          {resume.conflicts.length > 0 && (
            <Alert severity="warning">
              <Stack spacing={0.5}>
                <Typography variant="body2Strong">
                  {resume.conflicts.length} factual conflict
                  {resume.conflicts.length === 1 ? "" : "s"} with your settings:
                </Typography>
                {resume.conflicts.map((c) => (
                  <Typography key={c} variant="body2">
                    {c}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}
        </Stack>
      )}
    </SectionCard>
  );
}
