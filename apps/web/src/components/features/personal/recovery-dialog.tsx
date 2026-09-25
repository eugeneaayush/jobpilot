"use client";

import { type ReactElement, useEffect, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import type { PersonalCampaign } from "@jobpilot/contracts/personal-campaign";
import type {
  PersonalEligibilityAdjudicationInput,
  PersonalRecordRecoveryInput,
  personalRecoveryResponseSchema,
} from "@jobpilot/contracts/personal-recovery";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { z } from "zod/v4";
import { api } from "@/api/client";
import { apiErrorMessage, type EdenResult } from "@/api/error";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueries, personalQueryKeys } from "@/api/personal";
import { ColorChip, ExternalLink, LabelValue, RelativeTime } from "@/components/ui/display";
import { useToast } from "@/providers/notification-provider";

interface RecoveryDialogProps {
  record: PersonalRecordDto | null;
  open: boolean;
  onClose: () => void;
}

/** The contract exports DTO types for the parts we name; the response envelope derives here. */
type PersonalRecoveryResponse = z.infer<typeof personalRecoveryResponseSchema>;

type RequirementStatus = "satisfied" | "violated" | "unknown";
type CitationKind = "settings" | "resume" | "screening_answer";
type ProofKind = "retry_failure" | "screening_answers" | "eligibility";

const STATUS_LABEL: Record<RequirementStatus, string> = {
  satisfied: "Satisfied",
  violated: "Violated",
  unknown: "Unknown",
};
const STATUS_COLOR: Record<RequirementStatus, "success" | "error" | "default"> = {
  satisfied: "success",
  violated: "error",
  unknown: "default",
};

/** Attempt states are their own enum; render them without borrowing record-state labels. */
const attemptStateLabel = (state: string): string => state.replaceAll("_", " ");

/** Page size for the target-campaign selector; options accumulate page by page. */
const CAMPAIGN_PAGE_SIZE = 10;

/** Mutation errors carry the HTTP status so a 409 can be answered with a reload. */
interface StatusError extends Error {
  status?: number;
}

function throwWithStatus(result: EdenResult<unknown>): void {
  if (result.error === null) return;
  const error = new Error(apiErrorMessage(result.error)) as StatusError;
  error.status = typeof result.error.status === "number" ? result.error.status : undefined;
  throw error;
}

/** Honest option counts: never imply the list is complete while pages remain unloaded. */
function campaignCountText(loaded: number, total: number | null): string {
  if (total === null) return "Loading active campaigns…";
  if (total === 0)
    return "No active campaigns to transfer into — the original campaign stays the target.";
  return `Showing ${loaded} of ${total} active campaigns.`;
}

/** One requirement's user adjudication. Citations are typed-in, never inferred. */
interface DecisionDraft {
  status: RequirementStatus;
  rationale: string;
  sourceQuote: string;
  citationKind: CitationKind;
  /** settings/resume pointer, or screening-answer key. */
  pointer: string;
  /** screening-answer snapshot hash. */
  snapshotHash: string;
  value: string;
}

const EMPTY_DECISION: DecisionDraft = {
  status: "unknown",
  rationale: "",
  sourceQuote: "",
  citationKind: "settings",
  pointer: "",
  snapshotHash: "",
  value: "",
};

/** The contract requires rationale and quote on every decision; citations only when decided. */
function decisionValid(d: DecisionDraft): boolean {
  if (d.rationale.trim().length < 10 || d.sourceQuote.trim().length < 1) return false;
  if (d.status === "unknown") return true;
  if (d.pointer.trim().length < 1 || d.value.trim().length < 1) return false;
  return d.citationKind !== "screening_answer" || /^[a-f0-9]{64}$/.test(d.snapshotHash);
}

function buildDecisions(
  requirements: PersonalRecoveryResponse["requirements"],
  drafts: Record<string, DecisionDraft>,
): PersonalEligibilityAdjudicationInput["decisions"] | null {
  // Validate the drafts first, then build — the built objects carry no citation draft state.
  if (
    !requirements.every((requirement) => decisionValid(drafts[requirement.id] ?? EMPTY_DECISION))
  ) {
    return null;
  }
  return requirements.map((requirement) => {
    const d = drafts[requirement.id] ?? EMPTY_DECISION;
    return {
      requirementId: requirement.id,
      status: d.status,
      rationale: d.rationale.trim(),
      sourceQuote: d.sourceQuote.trim(),
      ...(d.status !== "unknown" && {
        citation:
          d.citationKind === "screening_answer"
            ? {
                kind: d.citationKind,
                snapshotHash: d.snapshotHash,
                key: d.pointer.trim(),
                value: d.value.trim(),
              }
            : { kind: d.citationKind, pointer: d.pointer.trim(), value: d.value.trim() },
      }),
    };
  });
}

/**
 * Recovery view for a record: the server's exact context, requirement statuses, and the
 * bounded retry window. The user may adjudicate eligibility only against stored facts they
 * cite verbatim — nothing is inferred, and nothing is auto-marked satisfied.
 */
export function RecoveryDialog(props: RecoveryDialogProps): ReactElement {
  const { record, open, onClose } = props;
  const toast = useToast();
  const [adjudicating, setAdjudicating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({});
  const [recoverReason, setRecoverReason] = useState("");
  const [proofKind, setProofKind] = useState<ProofKind>("retry_failure");
  const [proofRef, setProofRef] = useState("");
  const [targetCampaignId, setTargetCampaignId] = useState("");
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignOptions, setCampaignOptions] = useState<PersonalCampaign[]>([]);

  const recordId = record?.id ?? "";
  const campaigns = useApiQuery(
    personalQueries.campaigns({
      status: "active",
      page: campaignPage,
      limit: CAMPAIGN_PAGE_SIZE,
    }),
    { enabled: record !== null && open },
  );
  const recovery = useApiQuery(
    personalQueries.recovery(
      recordId || "00000000-0000-0000-0000-000000000000",
      targetCampaignId || undefined,
    ),
    // One def keeps the response type; enabled gates the fetch until a record is picked.
    { enabled: record !== null },
  );
  const data = recovery.data;

  // A different record starts from a clean slate: no target, loaded pages, drafts, or proof
  // carry over (adjust-state-on-prop-change; the immediate re-render converges).
  const [lastRecordId, setLastRecordId] = useState(recordId);
  if (recordId !== lastRecordId) {
    setLastRecordId(recordId);
    setTargetCampaignId("");
    setCampaignPage(1);
    setCampaignOptions([]);
    setDrafts({});
    setAdjudicating(false);
    setRecoverReason("");
    setProofKind("retry_failure");
    setProofRef("");
  }

  /** A target switch invalidates every draft built against the previous evidence. */
  const selectTargetCampaign = (id: string): void => {
    setTargetCampaignId(id);
    setDrafts({});
    setAdjudicating(false);
    setRecoverReason("");
    setProofKind("retry_failure");
    setProofRef("");
  };

  // Options accumulate page by page so Load more never hides already-fetched campaigns.
  useEffect(() => {
    const page = campaigns.data;
    if (!page) return;
    setCampaignOptions((prev) => {
      const base = page.pagination.page === 1 ? [] : prev;
      const seen = new Set(base.map((campaign) => campaign.id));
      return [...base, ...page.items.filter((campaign) => !seen.has(campaign.id))];
    });
  }, [campaigns.data]);

  // A 409 means the server context moved: reload the evidence rather than dead-ending the user.
  const onConflict = (error: Error): void => {
    if ((error as StatusError).status === 409) {
      toast.info(
        "Recovery context changed on the server — reloaded the latest evidence. Review and retry.",
      );
      void recovery.refetch();
      return;
    }
    toast.error(error.message);
  };
  const eligibility = useApiMutation<
    PersonalRecoveryResponse,
    PersonalEligibilityAdjudicationInput
  >(
    async (body) => {
      const result = await api.personal.recovery.records({ id: recordId }).eligibility.post(body);
      throwWithStatus(result);
      return result;
    },
    {
      invalidate: [personalQueryKeys.all],
      successMessage: "Eligibility adjudication saved",
      showErrorToast: false,
      onError: onConflict,
    },
  );
  const recover = useApiMutation<PersonalRecoveryResponse, PersonalRecordRecoveryInput>(
    async (body) => {
      const result = await api.personal.recovery.records({ id: recordId }).recover.post(body);
      throwWithStatus(result);
      return result;
    },
    {
      invalidate: [personalQueryKeys.all],
      successMessage: "Recovery requested",
      showErrorToast: false,
      onError: onConflict,
    },
  );

  if (!record || !data) {
    return (
      <Dialog open={open && record !== null} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle>Recovery</DialogTitle>
        <DialogContent>
          <LinearProgress />
        </DialogContent>
      </Dialog>
    );
  }

  // Uncertain submissions reconcile first: no recovery write may be offered or sent.
  const uncertain = record.state === "submission_uncertain";
  // Evidence must belong to the selected target: mismatched or in-flight views hold all writes.
  const evidenceTarget = data.recovery.targetCampaignId ?? "";
  const evidenceMatchesSelection = evidenceTarget === targetCampaignId;
  const evidenceHeld = !evidenceMatchesSelection || recovery.isFetching;
  const recoveryFormVisible =
    data.recovery.allowed && data.recovery.campaignRunId !== null && !uncertain;
  const proofRefValid =
    proofKind === "retry_failure" ||
    (proofKind === "screening_answers" ? /^[a-f0-9]{64}$/.test(proofRef) : proofRef.length > 0);
  const reasonValid = recoverReason.trim().length >= 10;

  const draft = (requirementId: string): DecisionDraft => drafts[requirementId] ?? EMPTY_DECISION;
  const setDraft = (requirementId: string, next: Partial<DecisionDraft>): void => {
    setDrafts((prev) => ({
      ...prev,
      [requirementId]: { ...(prev[requirementId] ?? EMPTY_DECISION), ...next },
    }));
  };

  const submitAdjudication = (): void => {
    if (evidenceHeld) return;
    const decisions = buildDecisions(data.requirements, drafts);
    if (!decisions) {
      toast.error(
        "Every decision needs a rationale (10+ chars) and a verbatim quote; decided ones also need a stored-fact citation.",
      );
      return;
    }
    // The exact server context and update time are echoed back — never reconstructed.
    eligibility.mutate({
      expectedUpdatedAt: new Date(data.updatedAt).toISOString(),
      context: data.context,
      decisions,
    });
  };

  const submitRecover = (): void => {
    if (
      !data.latestAttempt ||
      !data.recovery.campaignRunId ||
      !reasonValid ||
      !proofRefValid ||
      evidenceHeld
    ) {
      return;
    }
    recover.mutate({
      expectedUpdatedAt: new Date(data.updatedAt).toISOString(),
      context: data.context,
      attemptId: data.latestAttempt.id,
      campaignRunId: data.recovery.campaignRunId,
      // Only a chosen target adds the field; the default keeps the original-campaign POST.
      ...(targetCampaignId ? { targetCampaignId } : {}),
      reason: recoverReason.trim(),
      // A retry stays inside the already-authorized campaign run — no per-job re-authorization.
      proof:
        proofKind === "retry_failure"
          ? { kind: "retry_failure" }
          : proofKind === "screening_answers"
            ? { kind: "screening_answers", snapshotHash: proofRef }
            : { kind: "eligibility", adjudicationId: proofRef },
    });
  };

  return (
    <Dialog open={open && record !== null} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Recovery — {record.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {uncertain && (
            <Alert severity="warning">
              This submission is unconfirmed. Reconcile the outcome first — recovery writes stay
              disabled until the attempt is reconciled.
            </Alert>
          )}
          {data.recovery.blockers.length > 0 && (
            <Alert severity="error">Blocked: {data.recovery.blockers.join(" · ")}</Alert>
          )}

          <Stack spacing={1}>
            <TextField
              select
              label="Recovery target campaign"
              value={targetCampaignId}
              onChange={(e) => selectTargetCampaign(e.target.value)}
              helperText={campaignCountText(
                campaignOptions.length,
                campaigns.data ? campaigns.data.pagination.total : null,
              )}
              disabled={campaigns.isFetching && campaignOptions.length === 0}
              fullWidth
            >
              <MenuItem value="">Original campaign (default)</MenuItem>
              {campaignOptions.map((campaign) => (
                <MenuItem key={campaign.id} value={campaign.id}>
                  {campaign.name} · {campaign.id.slice(0, 8)}
                </MenuItem>
              ))}
            </TextField>
            {campaignPage < (campaigns.data?.pagination.totalPages ?? 1) && (
              <Button size="small" onClick={() => setCampaignPage((page) => page + 1)}>
                Load more campaigns (page {campaignPage} of{" "}
                {campaigns.data?.pagination.totalPages ?? 1})
              </Button>
            )}
          </Stack>

          {evidenceHeld && (
            <Alert severity="warning">
              The evidence shown does not match the selected target campaign — recovery and
              adjudication stay held until the matching evidence loads.
            </Alert>
          )}

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <LabelValue label="Server context (exact)">
                <Stack spacing={0.5}>
                  <Typography variant="captionMuted">identity {data.context.identity}</Typography>
                  <Typography variant="captionMuted">
                    posting {data.context.postingHash.slice(0, 12)} · settings{" "}
                    {data.context.settingsHash.slice(0, 12)}
                  </Typography>
                  <Typography variant="captionMuted">
                    evidence {data.context.evidenceHash.slice(0, 12)} · requirements{" "}
                    {data.context.requirementsHash.slice(0, 12)}
                  </Typography>
                </Stack>
              </LabelValue>
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <LabelValue label="Updated (server)">
                <RelativeTime value={data.updatedAt} variant="body2" />
              </LabelValue>
            </Grid>
            <Grid size={{ xs: 6, md: 4 }}>
              <LabelValue label="Evidence target">
                <Typography variant="body2">
                  {evidenceTarget ? `Campaign ${evidenceTarget.slice(0, 8)}` : "Original campaign"}
                </Typography>
              </LabelValue>
            </Grid>
            <Grid size={{ xs: 12, md: 8 }}>
              <LabelValue label="Source">
                <ExternalLink href={data.source.url} truncateTo={320}>
                  {data.source.title}
                </ExternalLink>
              </LabelValue>
            </Grid>
            <Grid size={{ xs: 6, md: 4 }}>
              <LabelValue label="Eligibility">
                <Chip
                  size="small"
                  variant="outlined"
                  color={
                    data.eligibility === "eligible"
                      ? "success"
                      : data.eligibility === "ineligible"
                        ? "error"
                        : "default"
                  }
                  label={data.eligibility}
                />
              </LabelValue>
            </Grid>
            {data.latestAttempt && (
              <Grid size={{ xs: 12, md: 8 }}>
                <LabelValue label="Latest attempt">
                  <Stack spacing={0.5}>
                    <Typography variant="body2">
                      {attemptStateLabel(data.latestAttempt.state)}
                    </Typography>
                    {/* submitAt is submit intent, not confirmation: the attempt state above
                        remains the authoritative outcome line. */}
                    {data.latestAttempt.submitAt ? (
                      <Typography variant="captionMuted">
                        Submission started <RelativeTime value={data.latestAttempt.submitAt} /> —
                        confirmation pending
                      </Typography>
                    ) : (
                      <Typography variant="captionMuted">Not yet submitted</Typography>
                    )}
                    {data.latestAttempt.reason && (
                      <Typography variant="captionMuted">{data.latestAttempt.reason}</Typography>
                    )}
                  </Stack>
                </LabelValue>
              </Grid>
            )}
            <Grid size={{ xs: 6, md: 4 }}>
              <LabelValue label="Retry window">
                <Typography variant="body2">
                  {data.recovery.retriesRemaining} left · {data.recovery.failedAttempts} failed
                </Typography>
              </LabelValue>
            </Grid>
          </Grid>

          <Stack spacing={1}>
            <Typography variant="overlineMuted">Requirements</Typography>
            {data.requirements.map((requirement) => (
              <Stack
                key={requirement.id}
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
                  <ColorChip
                    value={requirement.status}
                    colors={STATUS_COLOR}
                    label={STATUS_LABEL[requirement.status]}
                  />
                  <Typography variant="body2Strong">{requirement.requirement}</Typography>
                </Stack>
                <Typography variant="captionMuted">Evidence: {requirement.evidence}</Typography>
                {requirement.candidateEvidence && (
                  <Typography variant="captionMuted">
                    Candidate: {requirement.candidateEvidence}
                  </Typography>
                )}
                {adjudicating && (
                  <RequirementDecisionFields
                    draft={draft(requirement.id)}
                    onChange={(next) => setDraft(requirement.id, next)}
                  />
                )}
              </Stack>
            ))}
          </Stack>

          <Stack spacing={1}>
            <Typography variant="overlineMuted">History</Typography>
            {data.history.length === 0 ? (
              <Typography variant="body2Muted">No adjudications or recoveries yet.</Typography>
            ) : (
              data.history.map((entry) => (
                <Stack
                  key={entry.id}
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                >
                  <Chip size="small" variant="outlined" label={entry.kind} />
                  <Typography variant="body2">{entry.reason}</Typography>
                  <RelativeTime value={entry.createdAt} />
                </Stack>
              ))
            )}
          </Stack>

          <Stack spacing={1.5}>
            {!adjudicating ? (
              <Button size="small" onClick={() => setAdjudicating(true)}>
                Adjudicate eligibility from stored facts…
              </Button>
            ) : (
              <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
                <Button size="small" onClick={() => setAdjudicating(false)}>
                  Stop adjudicating
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={eligibility.isPending || evidenceHeld}
                  onClick={submitAdjudication}
                >
                  Submit adjudication
                </Button>
              </Stack>
            )}

            {recoveryFormVisible ? (
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1.5}
                sx={{ alignItems: { xs: "stretch", sm: "flex-end" } }}
              >
                <TextField
                  label="Recovery reason"
                  value={recoverReason}
                  onChange={(e) => setRecoverReason(e.target.value)}
                  helperText={`Retries inside the already-authorized run ${data.recovery.campaignRunId?.slice(0, 8) ?? ""} — no per-job re-authorization.`}
                  fullWidth
                />
                <TextField
                  select
                  label="Proof"
                  value={proofKind}
                  onChange={(e) => setProofKind(e.target.value as ProofKind)}
                  sx={{ minWidth: 220 }}
                >
                  <MenuItem value="retry_failure">Retry after transient failure</MenuItem>
                  <MenuItem value="screening_answers">Screening answers snapshot</MenuItem>
                  <MenuItem value="eligibility">Eligibility adjudication</MenuItem>
                </TextField>
                {proofKind !== "retry_failure" && (
                  <TextField
                    label={proofKind === "screening_answers" ? "Snapshot hash" : "Adjudication id"}
                    value={proofRef}
                    onChange={(e) => setProofRef(e.target.value)}
                    sx={{ minWidth: 220 }}
                  />
                )}
                <Button
                  variant="contained"
                  disabled={recover.isPending || !reasonValid || !proofRefValid || evidenceHeld}
                  onClick={submitRecover}
                >
                  Request recovery
                </Button>
              </Stack>
            ) : (
              <Typography variant="captionMuted">
                {uncertain
                  ? "Recovery stays disabled until the uncertain submission is reconciled."
                  : !data.recovery.allowed
                    ? "Recovery is not allowed for this record right now."
                    : "No authorized campaign run to retry within."}
              </Typography>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

interface RequirementDecisionFieldsProps {
  draft: DecisionDraft;
  onChange: (next: Partial<DecisionDraft>) => void;
}

/** Per-requirement adjudication inputs; citation fields appear only for decided statuses. */
function RequirementDecisionFields(props: RequirementDecisionFieldsProps): ReactElement {
  const { draft, onChange } = props;
  const cite = draft.status !== "unknown";
  return (
    <Grid container spacing={1.5}>
      <Grid size={{ xs: 12, sm: 3 }}>
        <TextField
          select
          label="Your verdict"
          value={draft.status}
          onChange={(e) => onChange({ status: e.target.value as RequirementStatus })}
          fullWidth
        >
          <MenuItem value="unknown">Unknown</MenuItem>
          <MenuItem value="satisfied">Satisfied</MenuItem>
          <MenuItem value="violated">Violated</MenuItem>
        </TextField>
      </Grid>
      <Grid size={{ xs: 12, sm: 9 }}>
        <TextField
          label="Rationale"
          value={draft.rationale}
          onChange={(e) => onChange({ rationale: e.target.value })}
          helperText="At least 10 characters."
          fullWidth
        />
      </Grid>
      <Grid size={12}>
        <TextField
          label="Source quote"
          value={draft.sourceQuote}
          onChange={(e) => onChange({ sourceQuote: e.target.value })}
          helperText="Quote the requirement's evidence or the posting verbatim."
          fullWidth
        />
      </Grid>
      {cite && (
        <>
          <Grid size={{ xs: 12, sm: 3 }}>
            <TextField
              select
              label="Stored fact"
              value={draft.citationKind}
              onChange={(e) => onChange({ citationKind: e.target.value as CitationKind })}
              fullWidth
            >
              <MenuItem value="settings">Settings</MenuItem>
              <MenuItem value="resume">Resume</MenuItem>
              <MenuItem value="screening_answer">Screening answer</MenuItem>
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField
              label={draft.citationKind === "screening_answer" ? "Answer key" : "Pointer"}
              value={draft.pointer}
              onChange={(e) => onChange({ pointer: e.target.value })}
              helperText="The stored location you are citing."
              fullWidth
            />
          </Grid>
          {draft.citationKind === "screening_answer" && (
            <Grid size={{ xs: 12, sm: 5 }}>
              <TextField
                label="Snapshot hash"
                value={draft.snapshotHash}
                onChange={(e) => onChange({ snapshotHash: e.target.value })}
                helperText="64-hex hash of the answer snapshot."
                fullWidth
              />
            </Grid>
          )}
          <Grid size={{ xs: 12, sm: draft.citationKind === "screening_answer" ? 12 : 5 }}>
            <TextField
              label="Stored value"
              value={draft.value}
              onChange={(e) => onChange({ value: e.target.value })}
              helperText="The exact stored value — the server verifies the match."
              fullWidth
            />
          </Grid>
        </>
      )}
    </Grid>
  );
}
