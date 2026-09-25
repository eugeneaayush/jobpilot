"use client";

import { type ReactElement, useState } from "react";
import type { PersonalDashboard } from "@jobpilot/contracts/personal";
import { History } from "@mui/icons-material";
import { Alert, Button, Chip, Stack, Typography } from "@mui/material";
import { EmptyState } from "@/components/ui/data";
import { ItemList, ItemRow, RelativeTime } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";
import { ChallengeDialog } from "./challenge-dialog";
import { HandoffDialog } from "./handoff-dialog";

/** Contract types for the optional progress block; absent on older payloads. */
type PersonalActivity = NonNullable<PersonalDashboard["activity"]>;
type PersonalSupervisor = NonNullable<PersonalDashboard["supervisor"]>;

interface ActivityPanelProps {
  activity: PersonalActivity | undefined;
  supervisor: PersonalSupervisor | null | undefined;
}

/** Recent attempts plus the supervisor's progress — with absences stated, not hidden. */
export function ActivityPanel(props: ActivityPanelProps): ReactElement {
  const { activity, supervisor } = props;
  const attempts = activity ?? [];
  const [handoffFor, setHandoffFor] = useState<string | null>(null);
  const [challengeFor, setChallengeFor] = useState<string | null>(null);

  return (
    <SectionCard
      title="Attempts"
      description="What the supervisor is doing with your records right now."
    >
      <Stack spacing={2}>
        {supervisor ? (
          <Stack
            direction="row"
            spacing={1.25}
            sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
          >
            <Chip size="small" color="info" variant="outlined" label={supervisor.status} />
            <Typography variant="captionMuted">supervisor</Typography>
            <RelativeTime value={supervisor.updatedAt} />
          </Stack>
        ) : (
          // No compatibility hiding: an unreported supervisor is a state, not a blank.
          <Alert severity="info">Supervisor is not reporting yet.</Alert>
        )}
        {supervisor?.error && <Alert severity="error">{supervisor.error}</Alert>}
        {attempts.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No attempts yet."
            description="Launch a campaign to start preparing records."
          />
        ) : (
          <ItemList>
            {attempts.map((attempt) => (
              <ItemRow
                key={attempt.id}
                icon={<History fontSize="sm" />}
                primary={
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                  >
                    <Chip
                      size="small"
                      variant="outlined"
                      color={attempt.mode === "submit" ? "warning" : "default"}
                      label={attempt.mode === "submit" ? "Submit" : "Offline"}
                    />
                    <Typography variant="body2Strong">{attempt.state}</Typography>
                    <Typography variant="captionMuted" sx={{ wordBreak: "break-all" }}>
                      {attempt.recordId}
                    </Typography>
                  </Stack>
                }
                action={
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <RelativeTime value={attempt.updatedAt} />
                    {/* Post-submit email verification, when the employer fences the submission. */}
                    <Button size="small" variant="text" onClick={() => setChallengeFor(attempt.id)}>
                      Challenge
                    </Button>
                    {/* Any attempt may be parked on a login/security challenge. */}
                    <Button size="small" variant="text" onClick={() => setHandoffFor(attempt.id)}>
                      Handoff
                    </Button>
                  </Stack>
                }
              />
            ))}
          </ItemList>
        )}
      </Stack>
      <HandoffDialog
        attemptId={handoffFor}
        open={handoffFor !== null}
        onClose={() => setHandoffFor(null)}
      />
      <ChallengeDialog
        attemptId={challengeFor}
        open={challengeFor !== null}
        onClose={() => setChallengeFor(null)}
      />
    </SectionCard>
  );
}
