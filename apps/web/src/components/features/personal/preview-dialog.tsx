"use client";

import { type ReactElement, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import { Checklist, OpenInNew } from "@mui/icons-material";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { API_BASE_URL } from "@/api/base-url";
import { api } from "@/api/client";
import { useApiMutation } from "@/api/hooks";
import { absoluteApiUrl, personalQueryKeys } from "@/api/personal";
import { CopyField, LabelValue } from "@/components/ui/display";
import { ELIGIBILITY_COLOR, ELIGIBILITY_LABEL } from "./personal-labels";

interface PreviewDialogProps {
  record: PersonalRecordDto | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Offline preview details. Read-only by construction: the only external actions are opening
 * the exact PDF and the CSP-isolated synthetic form — there is deliberately no submit or
 * send control in this preview dialog.
 */
export function PreviewDialog(props: PreviewDialogProps): ReactElement {
  const { record, open, onClose } = props;
  const preview = record?.preview ?? null;

  // QA may only be recorded against the exact record+PDF the user actually opened here.
  const [viewed, setViewed] = useState<{ recordId: string; pdfHash: string } | null>(null);
  const [notes, setNotes] = useState("");
  const freshness = record?.eligibilityFreshness ?? null;
  // A refreshed PDF or record invalidates the gate: the review binds to what was opened.
  const opened =
    viewed !== null &&
    record !== null &&
    preview !== null &&
    viewed.recordId === record.id &&
    viewed.pdfHash === preview.pdfHash
      ? viewed
      : null;

  const review = useApiMutation<PersonalRecordDto, { id: string; notes: string; pdfHash: string }>(
    ({ id, notes: reviewNotes, pdfHash }) =>
      api.personal({ id })["render-review"].post({
        pdfHash,
        inspected: true,
        notes: reviewNotes,
      }),
    {
      successMessage: "Visual review recorded",
      invalidate: [personalQueryKeys.all],
    },
  );

  /**
   * Open the API-served synthetic form directly: its CSP survives only on the API's own
   * document, and the localhost cookie authenticates the request. Still zero employer
   * requests — the form is synthetic and disabled.
   */
  const openOfflineForm = (): void => {
    if (!record) return;
    window.open(
      `${API_BASE_URL}/api/personal/${record.id}/form-preview`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const close = (): void => {
    setViewed(null);
    setNotes("");
    onClose();
  };
  return (
    <Dialog open={open && record !== null} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>{record ? `Preview — ${record.title}` : "Preview"}</DialogTitle>
      <DialogContent>
        {preview && record ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="info">
              {preview.mode === "offline"
                ? "Offline preview: rendered locally from your documents. Nothing was sent to the employer."
                : "Live form preview: this preview interacted with the employer's live form — entries and uploads may have been transmitted."}
            </Alert>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              <Chip
                size="small"
                color={preview.mode === "offline" ? "default" : "warning"}
                label={preview.mode === "offline" ? "Offline" : "Live form"}
              />
              <Chip
                size="small"
                color={preview.readiness === "ready" ? "success" : "default"}
                variant="outlined"
                label={preview.readiness === "ready" ? "Preview ready" : "Draft"}
              />
              <Chip
                size="small"
                color={preview.renderReviewed ? "success" : "warning"}
                variant="outlined"
                label={preview.renderReviewed ? "Visual review done" : "Visual review pending"}
              />
              {freshness?.status === "stale" || freshness?.status === "unknown" ? (
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
              ) : (
                <Chip
                  size="small"
                  variant="outlined"
                  color={ELIGIBILITY_COLOR[record.eligibility.decision]}
                  label={`Eligibility: ${ELIGIBILITY_LABEL[record.eligibility.decision]}`}
                />
              )}
            </Stack>
            {freshness?.status === "stale" && (
              <Alert severity="warning">
                Eligibility needs refresh —{" "}
                {freshness.reason ?? "the recorded verdict may predate a facts change"}. Document
                readiness does not make this application ready.
              </Alert>
            )}
            {freshness?.status === "unknown" && (
              <Alert severity="info">
                Eligibility freshness unknown —{" "}
                {freshness.reason ?? "the verdict's currency cannot be confirmed"}. Document
                readiness does not make this application ready.
              </Alert>
            )}
            {preview.conflicts.length > 0 && (
              <Alert severity="warning">
                <Stack spacing={0.5}>
                  {preview.conflicts.map((c) => (
                    <Typography key={c} variant="body2">
                      {c}
                    </Typography>
                  ))}
                </Stack>
              </Alert>
            )}
            <LabelValue label="PDF hash">
              <CopyField value={preview.pdfHash} ariaLabel="Copy PDF hash" />
            </LabelValue>
            <LabelValue label="Manifest hash">
              <CopyField value={preview.manifestHash} ariaLabel="Copy manifest hash" />
            </LabelValue>
            <Stack spacing={1}>
              <Typography variant="overlineMuted">Visual QA</Typography>
              <Typography variant="body2Muted">
                Open the exact PDF first — a review records what you actually inspected. Unresolved
                conflicts keep the preview a draft.
              </Typography>
              <TextField
                label="What you verified"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                multiline
                minRows={2}
                helperText={
                  opened !== null
                    ? "Required: one line about what you checked."
                    : "Open the exact PDF to enable review."
                }
                disabled={review.isPending}
              />
              <Button
                size="small"
                variant="outlined"
                startIcon={<Checklist fontSize="sm" />}
                disabled={opened === null || notes.trim().length === 0 || review.isPending}
                onClick={() =>
                  record &&
                  opened &&
                  review.mutate({ id: record.id, notes: notes.trim(), pdfHash: opened.pdfHash })
                }
              >
                Mark visually reviewed
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Typography variant="body2Muted">No preview has been generated.</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
        {preview && record && (
          <Button size="small" onClick={openOfflineForm} startIcon={<OpenInNew fontSize="sm" />}>
            Open offline form
          </Button>
        )}
        {/* The API-issued link, never a public capability link. Viewing it is the QA gate. */}
        {preview && (
          <Button
            component="a"
            href={absoluteApiUrl(preview.pdfUrl)}
            target="_blank"
            rel="noopener noreferrer"
            endIcon={<OpenInNew fontSize="sm" />}
            onClick={() =>
              record && preview && setViewed({ recordId: record.id, pdfHash: preview.pdfHash })
            }
          >
            Open exact PDF
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
