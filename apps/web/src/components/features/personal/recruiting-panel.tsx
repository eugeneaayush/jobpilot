"use client";

import type { ReactElement } from "react";
import type { Data } from "@jobpilot/api-client";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Button,
  Chip,
  Grid,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import type { api } from "@/api/client";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { SectionCard } from "@/components/ui/layout";

type Snapshot = NonNullable<Data<typeof api.personal.recruiting.get>["snapshot"]>;
type Firm = Snapshot["manifest"]["firms"][number];
type Evidence = Snapshot["manifest"]["evidence"][number];

const registrationLabels: Record<Firm["events"][number]["registrationStatus"], string> = {
  unknown: "Unknown",
  interest_submitted: "Interest submitted",
  invited_to_schedule: "Invited to schedule",
  registered: "Registered",
  full: "No available slots",
  waitlisted: "Waitlisted",
  cancelled: "Cancelled",
};

const attendanceLabels: Record<Firm["events"][number]["attendanceStatus"], string> = {
  unknown: "Not verified",
  attended: "Attended",
  missed: "Missed",
};

function dateLabel(date: Date, dayOnly = false): string {
  if (dayOnly) {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(date);
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

interface EvidenceReferencesProps {
  ids: string[];
  evidence: Evidence[];
}

function EvidenceReferences(props: EvidenceReferencesProps): ReactElement {
  const { ids, evidence } = props;
  const sources = evidence.filter((item) => ids.includes(item.id));
  return (
    <Typography variant="captionMuted">
      {sources.length === 0 && "No supporting evidence recorded."}
      {sources
        .map(
          (item) =>
            `${item.id} · ${item.kind.replaceAll("_", " ")} · ${dateLabel(item.observedAt)}`,
        )
        .join("; ")}
    </Typography>
  );
}

interface RecruitingFirmProps {
  firm: Firm;
  evidence: Evidence[];
}

function RecruitingFirm(props: RecruitingFirmProps): ReactElement {
  const { firm, evidence } = props;
  return (
    <SectionCard title={firm.name}>
      <Stack spacing={2}>
        <Chip
          variant="outlined"
          label={`Application: ${firm.applicationStatus.replaceAll("_", " ")}`}
        />
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">Application deadline</Typography>
          <Typography variant="body2">
            {firm.deadline.date ? dateLabel(firm.deadline.date, true) : "Not confirmed"}
            {firm.deadline.timeLabel && ` · ${firm.deadline.timeLabel}`}
            {` · ${firm.deadline.verification}`}
          </Typography>
          <EvidenceReferences ids={firm.deadline.evidenceIds} evidence={evidence} />
        </Stack>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Next actions</Typography>
          {firm.actions.length === 0 && (
            <Typography variant="body2Muted">No actions recorded.</Typography>
          )}
          {firm.actions.map((action) => (
            <Stack key={action.id} spacing={0.5}>
              <Typography variant="body2">{action.title}</Typography>
              <Typography variant="captionMuted">
                {action.status}
                {action.dueDate && ` · Target ${dateLabel(action.dueDate, true)}`}
              </Typography>
              {action.notes && <Typography variant="body2Muted">{action.notes}</Typography>}
              <EvidenceReferences ids={action.evidenceIds} evidence={evidence} />
            </Stack>
          ))}
        </Stack>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Events</Typography>
          {firm.events.length === 0 && (
            <Typography variant="body2Muted">No events recorded.</Typography>
          )}
          {firm.events.map((event) => (
            <Stack key={event.id} spacing={0.5}>
              <Typography variant="body2">{event.title}</Typography>
              <Typography variant="captionMuted">
                {event.startAt ? dateLabel(event.startAt) : "Time not confirmed"}
                {event.endAt && ` to ${dateLabel(event.endAt)}`}
                {event.timeLabel && ` · ${event.timeLabel}`}
              </Typography>
              <Typography variant="body2">
                Registration: {registrationLabels[event.registrationStatus]}
              </Typography>
              <Typography variant="body2">
                Attendance: {attendanceLabels[event.attendanceStatus]}
              </Typography>
              {event.notes && <Typography variant="body2Muted">{event.notes}</Typography>}
              {httpUrl(event.url) && (
                <Link
                  href={httpUrl(event.url) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Event details
                </Link>
              )}
              <EvidenceReferences ids={event.evidenceIds} evidence={evidence} />
            </Stack>
          ))}
        </Stack>
      </Stack>
    </SectionCard>
  );
}

interface RecruitingSnapshotProps {
  snapshot: Snapshot;
}

function RecruitingSnapshot(props: RecruitingSnapshotProps): ReactElement {
  const { snapshot } = props;
  const { manifest } = snapshot;
  const stale =
    Date.now() - Math.min(snapshot.capturedAt.getTime(), manifest.updatedAt.getTime()) > 86_400_000;
  return (
    <Stack spacing={2}>
      <Typography variant="body2">{manifest.objective}</Typography>
      <Typography variant="body2">
        {manifest.cycle} · Office priority: {manifest.officePreferences.join(" → ")}
      </Typography>
      <Typography variant="captionMuted">
        Imported {dateLabel(snapshot.capturedAt)} · Source updated {dateLabel(manifest.updatedAt)}
      </Typography>
      {stale && (
        <Alert severity="warning">
          This snapshot or its source is over 24 hours old. Event availability and deadlines may
          have changed; check the dated evidence before acting.
        </Alert>
      )}
      <Grid container spacing={2}>
        {manifest.firms.map((firm) => (
          <Grid key={firm.id} size={{ xs: 12, xl: 4 }}>
            <RecruitingFirm firm={firm} evidence={manifest.evidence} />
          </Grid>
        ))}
      </Grid>
      <Accordion>
        <AccordionSummary>Evidence and source history</AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5}>
            {manifest.evidence.map((item) => (
              <Stack key={item.id} spacing={0.5}>
                <Typography variant="subtitle2">{item.id}</Typography>
                <Typography variant="captionMuted">
                  {item.kind.replaceAll("_", " ")} · Observed {dateLabel(item.observedAt)}
                </Typography>
                <Typography variant="body2">{item.summary}</Typography>
                {httpUrl(item.url) && (
                  <Link
                    href={httpUrl(item.url) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Official source
                  </Link>
                )}
              </Stack>
            ))}
            <Typography variant="captionMuted" sx={{ overflowWrap: "anywhere" }}>
              Source SHA256: {snapshot.source.sha256}
              {" · "}Git revision: {snapshot.source.gitHead}
              {snapshot.source.gitDirty && " · Source checkout had local changes"}
            </Typography>
          </Stack>
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}

export function RecruitingPanel(): ReactElement {
  const query = useApiQuery(personalQueries.recruiting());
  const snapshot = query.data?.snapshot;
  return (
    <SectionCard
      title="MBB internship campaign"
      description="McKinsey, Bain and BCG, from your mba-buyside recruiting record."
    >
      <Stack spacing={2}>
        <Typography variant="captionMuted">
          This view reads the last imported record. Registration and attendance are tracked
          separately. Refresh reloads the local snapshot.
        </Typography>
        {query.isLoading && (
          <Typography variant="body2Muted">Loading recruiting record…</Typography>
        )}
        {query.isError && <Alert severity="error">Couldn&apos;t load the recruiting record.</Alert>}
        {query.data?.status === "missing" && (
          <Alert severity="info">
            No recruiting snapshot has been imported. Import the mba-buyside recruiting record to
            see the three firm plans here.
          </Alert>
        )}
        {query.data?.status === "invalid" && (
          <Alert severity="error">
            The recruiting snapshot could not be accessed safely or validated. Check the private
            file permissions and snapshot contents before retrying.
          </Alert>
        )}
        {snapshot && <RecruitingSnapshot snapshot={snapshot} />}
        <Button variant="text" onClick={() => void query.refetch()} disabled={query.isFetching}>
          Refresh recruiting record
        </Button>
      </Stack>
    </SectionCard>
  );
}
