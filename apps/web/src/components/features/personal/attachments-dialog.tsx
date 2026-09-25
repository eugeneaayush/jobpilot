"use client";

import { type ReactElement, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import type { personalAttachmentsResponseSchema } from "@jobpilot/contracts/personal-attachments";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { z } from "zod/v4";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { absoluteApiUrl, personalQueries, personalQueryKeys } from "@/api/personal";
import { LabelValue, RelativeTime } from "@/components/ui/display";
import { useToast } from "@/providers/notification-provider";

interface AttachmentsDialogProps {
  record: PersonalRecordDto | null;
  open: boolean;
  onClose: () => void;
}

/** The contract exports DTO types for the parts we name; the response envelope derives here. */
type AttachmentsResponse = z.infer<typeof personalAttachmentsResponseSchema>;
type AttachmentDocument = AttachmentsResponse["documents"][number];
type AttachmentRequirement = AttachmentsResponse["requirements"][number];

const KIND_LABEL: Record<AttachmentRequirement["kind"], string> = {
  resume: "Resume",
  cover_letter: "Cover letter",
  other: "Other",
};

/**
 * Per-record required attachments: what the employer's public questions ask for, the
 * source-backed documents on file, and the explicit visual review each one still needs.
 * Nothing here launches or submits anything.
 */
export function AttachmentsDialog(props: AttachmentsDialogProps): ReactElement {
  const { record, open, onClose } = props;
  const toast = useToast();
  // inspected is only ever sent from an explicit click on a PDF the user actually opened.
  const [viewedHashes, setViewedHashes] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});

  const attachments = useApiQuery(
    personalQueries.attachments(record?.id ?? "00000000-0000-0000-0000-000000000000"),
    { enabled: record !== null },
  );
  const data = attachments.data;
  const invalidate = [personalQueryKeys.all];

  const refresh = useApiMutation(
    (id: string) => api.personal.attachments({ id }).requirements.refresh.post(),
    { invalidate, successMessage: "Requirements refreshed from public posting metadata" },
  );
  const coverLetter = useApiMutation(
    (body: { fieldName: string }) =>
      api.personal.attachments({ id: record?.id ?? "" })["cover-letter"].post(body),
    { invalidate, successMessage: "Cover letter draft built from your sources" },
  );
  const review = useApiMutation(
    (body: { attachmentId: string; pdfHash: string; notes: string }) =>
      api.personal.attachments({ id: record?.id ?? "" }).review.post({ ...body, inspected: true }),
    { invalidate, successMessage: "Attachment review recorded" },
  );
  const rerunPreview = useApiMutation((id: string) => api.personal({ id }).preview.post(), {
    invalidate,
    successMessage: "Offline preview rerun",
  });

  if (!record || !data) {
    return (
      <Dialog open={open && record !== null} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle>Attachments</DialogTitle>
        <DialogContent>
          <LinearProgress />
        </DialogContent>
      </Dialog>
    );
  }

  const markViewed = (sha256: string): void => {
    setViewedHashes((prev) => new Set(prev).add(sha256));
  };

  const submitReview = (doc: AttachmentDocument): void => {
    const reviewNotes = (notes[doc.id] ?? "").trim();
    if (!viewedHashes.has(doc.sha256) || reviewNotes.length === 0) {
      toast.error("Open the exact PDF and note what you verified before recording a review.");
      return;
    }
    review.mutate({ attachmentId: doc.id, pdfHash: doc.sha256, notes: reviewNotes });
  };

  const docFor = (requirement: AttachmentRequirement): AttachmentDocument | undefined =>
    data.documents.find((doc) => doc.fieldName === requirement.fieldName);

  return (
    <Dialog open={open && record !== null} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Attachments — {record.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {data.readiness !== "ready" && (
            <Alert severity={data.readiness === "unknown" ? "info" : "warning"}>
              {data.readiness === "unknown"
                ? "Attachment requirements are unknown — this record is not ready."
                : `Not ready: ${
                    data.missingRequired.length > 0
                      ? `missing ${data.missingRequired.join(", ")}`
                      : "a document is still a draft pending review"
                  }.`}
            </Alert>
          )}
          {data.requiresPreview && (
            <Alert severity="info">
              The preview must be rerun for these attachments to take effect in a run.
              <Button
                size="small"
                sx={{ ml: 1 }}
                disabled={rerunPreview.isPending}
                onClick={() => rerunPreview.mutate(record.id)}
              >
                Rerun offline preview
              </Button>
            </Alert>
          )}

          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="overlineMuted" sx={{ flex: 1 }}>
                Requirements
              </Typography>
              <Button
                size="small"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate(record.id)}
              >
                Refresh from posting
              </Button>
            </Stack>
            {data.requirementsSource === null ? (
              // Unknown (never inspected) is its own state — not "none required".
              <Typography variant="body2Muted">
                Unknown — no requirement snapshot yet. Refresh reads the employer&apos;s public
                questions metadata only; nothing about you is transmitted.
              </Typography>
            ) : data.requirements.length === 0 ? (
              <Typography variant="body2Muted">No attachments required.</Typography>
            ) : (
              data.requirements.map((requirement) => {
                const doc = docFor(requirement);
                return (
                  <Stack
                    key={requirement.fieldName}
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                  >
                    <Chip size="small" variant="outlined" label={KIND_LABEL[requirement.kind]} />
                    <Typography variant="body2" sx={{ minWidth: 0, wordBreak: "break-word" }}>
                      {requirement.label}
                    </Typography>
                    {requirement.required && (
                      <Chip size="small" color="warning" variant="outlined" label="required" />
                    )}
                    {!doc && requirement.kind === "cover_letter" && (
                      <Button
                        size="small"
                        variant="text"
                        disabled={coverLetter.isPending}
                        onClick={() => coverLetter.mutate({ fieldName: requirement.fieldName })}
                      >
                        Draft cover letter
                      </Button>
                    )}
                    {!doc && requirement.required && requirement.kind !== "cover_letter" && (
                      <Chip size="small" color="error" variant="outlined" label="missing" />
                    )}
                  </Stack>
                );
              })
            )}
          </Stack>

          <Stack spacing={1}>
            <Typography variant="overlineMuted">Documents</Typography>
            {data.documents.length === 0 ? (
              <Typography variant="body2Muted">No source-backed documents on file yet.</Typography>
            ) : (
              data.documents.map((doc) => (
                <Stack
                  key={doc.id}
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
                    <Chip size="small" variant="outlined" label={KIND_LABEL[doc.kind]} />
                    <Typography variant="body2Strong">{doc.label || doc.fieldName}</Typography>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={doc.review ? "success" : "warning"}
                      label={doc.review ? "Review recorded" : "Review pending"}
                    />
                    <RelativeTime value={doc.createdAt} />
                  </Stack>
                  <Typography variant="captionMuted">
                    {doc.bytes} bytes · sha256 {doc.sha256.slice(0, 12)} ·{" "}
                    {doc.source.citations.length} source citations
                  </Typography>
                  {doc.review ? (
                    <Typography variant="captionMuted">Review: {doc.review.notes}</Typography>
                  ) : (
                    <Stack spacing={1}>
                      {/* Viewing the exact PDF is the gate; inspected is never auto-set. */}
                      <Button
                        component="a"
                        href={absoluteApiUrl(doc.pdfUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => markViewed(doc.sha256)}
                      >
                        Open exact PDF
                      </Button>
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                        <TextField
                          label="What you verified"
                          value={notes[doc.id] ?? ""}
                          onChange={(e) =>
                            setNotes((prev) => ({ ...prev, [doc.id]: e.target.value }))
                          }
                          helperText={
                            viewedHashes.has(doc.sha256)
                              ? "Required: one line about what you checked."
                              : "Open the exact PDF above to enable review."
                          }
                          disabled={review.isPending}
                          fullWidth
                        />
                        <Button
                          variant="outlined"
                          disabled={
                            !viewedHashes.has(doc.sha256) ||
                            (notes[doc.id] ?? "").trim().length === 0 ||
                            review.isPending
                          }
                          onClick={() => submitReview(doc)}
                        >
                          Mark visually reviewed
                        </Button>
                      </Stack>
                    </Stack>
                  )}
                </Stack>
              ))
            )}
          </Stack>

          <LabelValue label="Updated (server)">
            <RelativeTime value={data.updatedAt} variant="body2" />
          </LabelValue>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
