"use client";

import { type ReactElement, useState } from "react";
import type { Pagination } from "@jobpilot/contracts/pagination";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import { Description, Visibility } from "@mui/icons-material";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { api } from "@/api/client";
import { useApiMutation } from "@/api/hooks";
import { absoluteApiUrl, personalQueryKeys } from "@/api/personal";
import { DataTable } from "@/components/ui/data/data-table";
import { SelectField, type SelectFieldOption } from "@/components/ui/form";
import { SectionCard } from "@/components/ui/layout";
import type { PaginationParams } from "@/hooks/use-pagination";
import { gridPagination } from "@/hooks/use-pagination";
import { plural } from "@/utils/format";
import { AnswersDialog } from "./answers-dialog";
import { ApplicationReviewDialog } from "./application-review-dialog";
import { AttachmentsDialog } from "./attachments-dialog";
import { FitEvidenceDialog } from "./fit-evidence-dialog";
import { FollowupsDialog } from "./followups-dialog";
import {
  ELIGIBILITY_COLOR,
  ELIGIBILITY_LABEL,
  type PersonalTrack,
  prepareBlockedReason,
  SENIORITY_COLOR,
  SENIORITY_LABEL,
  STATE_COLOR,
  STATE_LABEL,
  TRACK_LABEL,
} from "./personal-labels";
import { PreviewDialog } from "./preview-dialog";
import { RecoveryDialog } from "./recovery-dialog";
import { ResumeYamlDialog } from "./resume-yaml-dialog";
import { SeniorityAssessment } from "./seniority-assessment";

/** Rows in these states get the Recover action; uncertain ones open reconcile-first. */
const RECOVERABLE_STATES: readonly PersonalRecordDto["state"][] = [
  "blocked",
  "failed",
  "submission_uncertain",
];

const TRACK_OPTIONS: ReadonlyArray<SelectFieldOption<PersonalTrack>> = (
  Object.keys(TRACK_LABEL) as PersonalTrack[]
).map((value) => ({ value, label: TRACK_LABEL[value] }));

interface RecordsTableProps {
  records: ReadonlyArray<PersonalRecordDto>;
  paginationMeta: Pagination | undefined;
  loading: boolean;
  /** Preview is a capability; when absent the button explains instead of failing. */
  offlinePreview: boolean;
  /** Pagination owns the URL-backed page state; the track filter rides the same params. */
  pagination: PaginationParams;
  track: PersonalTrack | null;
  onTrackChange: (track: PersonalTrack | null) => void;
}

/** The record list: track, durable state, eligibility vs fit, missing inputs, preview + exact PDF. */
export function RecordsTable(props: RecordsTableProps): ReactElement {
  const { records, paginationMeta, loading, offlinePreview, pagination, track, onTrackChange } =
    props;
  const [previewed, setPreviewed] = useState<PersonalRecordDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [answersFor, setAnswersFor] = useState<PersonalRecordDto | null>(null);
  const [recovering, setRecovering] = useState<PersonalRecordDto | null>(null);
  const [filesFor, setFilesFor] = useState<PersonalRecordDto | null>(null);
  const [approvalFor, setApprovalFor] = useState<PersonalRecordDto | null>(null);
  const [fitFor, setFitFor] = useState<PersonalRecordDto | null>(null);
  const [yamlFor, setYamlFor] = useState<string | null>(null);
  const [followupFor, setFollowupFor] = useState<PersonalRecordDto | null>(null);
  const [seniorityFor, setSeniorityFor] = useState<PersonalRecordDto | null>(null);
  // Retain a mutation response until the list catches up, then use its freshest version.
  const latestRecord = (selected: PersonalRecordDto | null): PersonalRecordDto | null => {
    const current = records.find((record) => record.id === selected?.id);
    if (!selected || !current) return selected;
    return new Date(current.updatedAt).getTime() >= new Date(selected.updatedAt).getTime()
      ? current
      : selected;
  };
  const currentPreview = latestRecord(previewed);
  const currentAnswers = latestRecord(answersFor);

  const preview = useApiMutation<PersonalRecordDto, string>(
    (id) => api.personal({ id }).preview.post(),
    {
      invalidate: [personalQueryKeys.all],
      onSuccess: (record) => {
        setPreviewed(record);
        setDialogOpen(true);
      },
    },
  );

  const columns: GridColDef<PersonalRecordDto>[] = [
    {
      field: "state",
      headerName: "State",
      width: 165,
      renderCell: (p) => (
        <Chip
          size="small"
          variant="outlined"
          color={STATE_COLOR[p.row.state]}
          label={STATE_LABEL[p.row.state]}
        />
      ),
      sortable: false,
    },
    {
      field: "track",
      headerName: "Track",
      width: 160,
      renderCell: (p) => <Chip size="small" label={TRACK_LABEL[p.row.track]} variant="outlined" />,
      sortable: false,
    },
    {
      field: "title",
      headerName: "Role",
      flex: 1.6,
      minWidth: 220,
      renderCell: (p) => (
        <Stack sx={{ minWidth: 0, py: 0.5 }}>
          <Link
            href={p.row.url}
            target="_blank"
            rel="noopener noreferrer"
            color="inherit"
            sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {p.row.title}
          </Link>
          <Typography variant="captionMuted" noWrap>
            {p.row.company} ·{" "}
            {p.row.requisitionId ? `source id ${p.row.requisitionId}` : "no source id"}
          </Typography>
        </Stack>
      ),
      sortable: false,
    },
    {
      // Eligibility is a hard requirement verdict; the Fit column below is the score. Never merged.
      // A stale or unknown-freshness verdict is never shown as its decision label.
      field: "eligibility",
      headerName: "Eligibility",
      width: 190,
      renderCell: (p) => {
        const freshness = p.row.eligibilityFreshness;
        if (freshness?.status === "stale" || freshness?.status === "unknown") {
          return (
            <Tooltip
              title={
                freshness.reason ??
                (freshness.status === "stale"
                  ? "The eligibility verdict is stale; refresh it before relying on it."
                  : "The freshness of this eligibility verdict is unknown.")
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={freshness.status === "stale" ? "warning" : "default"}
                label={
                  freshness.status === "stale"
                    ? "Eligibility needs refresh"
                    : "Eligibility freshness unknown"
                }
              />
            </Tooltip>
          );
        }
        return (
          <Tooltip
            title={
              p.row.eligibility.reasons.length > 0 ? (
                <Stack spacing={0.5}>
                  {p.row.eligibility.reasons.map((r) => (
                    <Typography key={r} variant="caption">
                      {r}
                    </Typography>
                  ))}
                </Stack>
              ) : (
                "No reasons recorded"
              )
            }
          >
            <Chip
              size="small"
              variant="outlined"
              color={ELIGIBILITY_COLOR[p.row.eligibility.decision]}
              label={ELIGIBILITY_LABEL[p.row.eligibility.decision]}
            />
          </Tooltip>
        );
      },
      sortable: false,
    },
    {
      field: "fitScore",
      headerName: "Fit",
      width: 70,
      align: "right",
      headerAlign: "right",
      valueGetter: (_v, row) => row.fitScore ?? "—",
      renderCell: (p) => (
        <Button
          size="small"
          aria-label={`Fit evidence for ${p.row.title}`}
          onClick={() => setFitFor(p.row)}
        >
          {p.row.fitScore ?? "—"}
        </Button>
      ),
    },
    {
      // API-authoritative seniority: chips only when classified; absence renders nothing.
      field: "seniority",
      headerName: "Seniority",
      width: 150,
      renderCell: (p) =>
        p.row.seniority ? (
          <Tooltip describeChild title="Why this posting is in or out of scope">
            <Chip
              size="small"
              variant="outlined"
              color={SENIORITY_COLOR[p.row.seniority.classification]}
              label={SENIORITY_LABEL[p.row.seniority.classification]}
              onClick={() => setSeniorityFor(p.row)}
            />
          </Tooltip>
        ) : (
          <Typography variant="body2Muted">—</Typography>
        ),
      sortable: false,
    },
    {
      field: "missingAnswers",
      headerName: "Missing",
      width: 90,
      align: "right",
      headerAlign: "right",
      renderCell: (p) =>
        p.row.missingAnswers.length > 0 ? (
          <Tooltip
            title={
              <Stack spacing={0.5}>
                {p.row.missingAnswers.map((a) => (
                  <Typography key={a} variant="caption">
                    {a}
                  </Typography>
                ))}
              </Stack>
            }
          >
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              label={p.row.missingAnswers.length}
            />
          </Tooltip>
        ) : (
          <Typography variant="body2Muted">—</Typography>
        ),
      sortable: false,
    },
    {
      field: "actions",
      headerName: "",
      width: 680,
      sortable: false,
      filterable: false,
      align: "right",
      headerAlign: "right",
      renderCell: (p) => (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Button size="small" onClick={() => setApprovalFor(p.row)}>
            Review application
          </Button>
          <Button size="small" onClick={() => setYamlFor(p.row.id)}>
            YAML
          </Button>
          {p.row.state === "submitted" && (
            <Button size="small" onClick={() => setFollowupFor(p.row)}>
              Follow-up draft
            </Button>
          )}
          <Tooltip
            describeChild
            title="Answer this job's screening questions. Nothing is autofilled."
          >
            <Button size="small" variant="text" onClick={() => setAnswersFor(p.row)}>
              Answers
            </Button>
          </Tooltip>
          <Tooltip
            describeChild
            title="Required attachments, source-backed documents, and their visual reviews."
          >
            <Button size="small" variant="text" onClick={() => setFilesFor(p.row)}>
              Files
            </Button>
          </Tooltip>
          {RECOVERABLE_STATES.includes(p.row.state) && (
            <Tooltip
              describeChild
              title="Requirements, evidence, and a bounded retry inside the authorized run."
            >
              <Button size="small" variant="text" onClick={() => setRecovering(p.row)}>
                Recover
              </Button>
            </Tooltip>
          )}
          {/* A disabled button emits no pointer events; the span keeps the tooltip hoverable. */}
          <Tooltip
            title={
              prepareBlockedReason(p.row.seniority) ??
              (offlinePreview
                ? "Render an offline preview locally. Nothing is sent."
                : "Offline preview is not available from this build.")
            }
          >
            <Box component="span" sx={{ display: "inline-flex" }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<Visibility fontSize="sm" />}
                disabled={
                  !offlinePreview ||
                  preview.isPending ||
                  prepareBlockedReason(p.row.seniority) !== null
                }
                onClick={() => preview.mutate(p.row.id)}
              >
                Preview
              </Button>
            </Box>
          </Tooltip>
          {p.row.preview && (
            <Tooltip title="Open the exact PDF for this record">
              <Button
                size="small"
                variant="text"
                component="a"
                href={absoluteApiUrl(p.row.preview.pdfUrl)}
                target="_blank"
                rel="noopener noreferrer"
                startIcon={<Description fontSize="sm" />}
              >
                PDF
              </Button>
            </Tooltip>
          )}
        </Stack>
      ),
    },
  ];

  return (
    <SectionCard
      title="Records"
      description="Every discovered role by track. Previews are offline. Live applications require approval of exact answers and files."
    >
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={1.5}
        sx={{ alignItems: { xs: "stretch", md: "center" }, mb: 2 }}
      >
        <SelectField label="Track" value={track} options={TRACK_OPTIONS} onChange={onTrackChange} />
        <Box sx={{ flex: 1 }} />
        <Typography variant="captionMuted">
          {plural(paginationMeta?.total ?? records.length, "record")}
        </Typography>
      </Stack>
      <DataTable
        rows={records}
        columns={columns}
        loading={loading}
        getRowId={(row) => row.id}
        emptyMessage={
          track
            ? `No ${TRACK_LABEL[track].toLowerCase()} records yet.`
            : "No records yet. Run a discovery to list jobs."
        }
        {...gridPagination(pagination, paginationMeta)}
      />
      <PreviewDialog
        key={`${currentPreview?.id}-${currentPreview?.preview?.pdfHash}-${dialogOpen}`}
        record={currentPreview}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
      {approvalFor && (
        <ApplicationReviewDialog
          key={approvalFor.id}
          record={latestRecord(approvalFor)!}
          onClose={() => setApprovalFor(null)}
        />
      )}
      {fitFor && (
        <FitEvidenceDialog record={latestRecord(fitFor)!} onClose={() => setFitFor(null)} />
      )}
      {yamlFor && (
        <ResumeYamlDialog key={yamlFor} recordId={yamlFor} onClose={() => setYamlFor(null)} />
      )}
      {followupFor && (
        <FollowupsDialog
          key={followupFor.id}
          record={latestRecord(followupFor)!}
          onClose={() => setFollowupFor(null)}
        />
      )}
      <AnswersDialog
        record={currentAnswers}
        open={answersFor !== null}
        onClose={() => setAnswersFor(null)}
      />
      <RecoveryDialog
        record={latestRecord(recovering)}
        open={recovering !== null}
        onClose={() => setRecovering(null)}
      />
      <AttachmentsDialog
        record={latestRecord(filesFor)}
        open={filesFor !== null}
        onClose={() => setFilesFor(null)}
      />
      <SeniorityDialog
        record={latestRecord(seniorityFor)}
        open={seniorityFor !== null}
        onClose={() => setSeniorityFor(null)}
      />
    </SectionCard>
  );
}

interface SeniorityDialogProps {
  record: PersonalRecordDto | null;
  open: boolean;
  onClose: () => void;
}

/** Detail view of the API's seniority classification, with its reasons and source quotes. */
function SeniorityDialog(props: SeniorityDialogProps): ReactElement {
  const { record, open, onClose } = props;
  const seniority = record?.seniority ?? null;

  return (
    <Dialog open={open && seniority !== null} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Seniority — {record?.title ?? ""}</DialogTitle>
      <DialogContent>
        {seniority ? (
          <SeniorityAssessment
            classification={seniority.classification}
            reasons={seniority.reasons}
            evidence={seniority.evidence}
          />
        ) : (
          <Typography variant="body2Muted">No seniority classification recorded.</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
