"use client";

import { type ReactElement, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { absoluteApiUrl, personalQueries, personalQueryKeys } from "@/api/personal";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rows(value: unknown) {
  return Array.isArray(value) ? value.map(object) : [];
}
function text(value: unknown) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "string" || typeof value === "number" ? String(value) : "Not supplied";
}

interface ApplicationReviewDialogProps {
  record: PersonalRecordDto;
  onClose: () => void;
}

export function ApplicationReviewDialog({
  record,
  onClose,
}: ApplicationReviewDialogProps): ReactElement {
  const query = useApiQuery(personalQueries.approval(record.id), {
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const [openedHash, setOpenedHash] = useState<string | null>(null);
  const current = query.data;
  const approve = useApiMutation(
    (input: { expectedRecordVersion: string; packetHash: string; nonce: string; confirm: true }) =>
      api.personal.approvals.records({ id: record.id }).post(input),
    {
      invalidate: [personalQueryKeys.all],
      onError: () => {
        void query.refetch();
      },
    },
  );
  const withdraw = useApiMutation(
    (input: {
      approvalId: string;
      expectedRecordVersion: string;
      packetHash: string;
      nonce: string;
      confirm: true;
      recordId: string;
    }) => {
      const { approvalId, ...body } = input;
      return api.personal.approvals({ id: approvalId }).withdraw.post(body);
    },
    {
      invalidate: [personalQueryKeys.all],
      onError: () => {
        void query.refetch();
      },
    },
  );
  const packet = current?.packet;
  const manifest = object(packet?.preparedManifest);
  const answers = rows(manifest.answers);
  const attachments = rows(manifest.attachments);
  const inventory = object(manifest.attachmentRequirements);
  const requirements = rows(inventory.requirements);
  const snapshot = object(manifest.screeningAnswerSnapshot);
  const sourcedAnswers = rows(snapshot.answers);
  const document = object(manifest.document);
  const email = object(object(packet?.evidence).applicationEmail);
  const evidence = object(packet?.evidence);
  const verification = object(evidence.documentVerification);
  const tailoring = object(evidence.tailoring);
  const activeApproval =
    current?.approval?.status === "approved" || current?.approval?.status === "bound";
  const busy = approve.isPending || withdraw.isPending || query.isFetching;
  const input = current
    ? {
        expectedRecordVersion: current.recordVersion.toISOString(),
        packetHash: current.packetHash,
        nonce: current.nonce,
        confirm: true as const,
      }
    : null;

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Review application — {record.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="info">
            Approval authorizes this application’s exact answers and files to be entered, uploaded
            and submitted. Fields and uploads can reach the employer before the final submit action.
          </Alert>
          {query.isLoading && <CircularProgress aria-label="Loading review packet" />}
          {query.error && <Alert severity="error">{query.error.message}</Alert>}
          {current?.blockers.map((blocker) => (
            <Alert key={blocker} severity="warning">
              {blocker}
            </Alert>
          ))}
          {current?.approval && (
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Chip
                label={`Approval: ${current.approval.status}`}
                color={activeApproval ? "success" : "default"}
              />
              <Typography variant="caption">
                Expires {current.approval.expiresAt.toLocaleString()}
              </Typography>
            </Stack>
          )}
          {packet && (
            <>
              <Typography variant="h6">{packet.company}</Typography>
              <Link href={packet.destination} target="_blank" rel="noopener noreferrer">
                Employer posting
              </Link>
              <Typography variant="body2">
                Requisition: {packet.requisitionId ?? "Recorded source identity"}
              </Typography>
              <Accordion>
                <AccordionSummary>Posting evidence</AccordionSummary>
                <AccordionDetails>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                    {text(object(evidence.posting).descriptionText)}
                  </Typography>
                </AccordionDetails>
              </Accordion>
              <Typography variant="body2">
                Claims: {text(tailoring.status ?? "extractive source selection")} · Document checks:{" "}
                {text(verification.status)} · Visual review:{" "}
                {object(evidence.preview).renderReviewed === true ? "reviewed" : "pending"}
              </Typography>
              {rows(verification.checks)
                .filter((check) => check.status !== "passed")
                .map((check) => (
                  <Alert key={String(check.code)} severity="warning">
                    {text(check.message)}
                  </Alert>
                ))}
              <Divider />
              <Typography variant="subtitle1">Exact answers</Typography>
              {answers.length === 0 && (
                <Typography variant="body2">
                  No screening answers are included. A new required question will stop the
                  application for review.
                </Typography>
              )}
              {answers.map((answer, index) => {
                const source = sourcedAnswers.find((item) => item.key === answer.key);
                return (
                  <Box key={String(answer.key ?? index)}>
                    <Typography variant="subtitle2">
                      {text(answer.label ?? answer.fieldName ?? answer.key)}
                    </Typography>
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                      {text(answer.value)}
                    </Typography>
                    {source && (
                      <Typography variant="caption" color="text.secondary">
                        Source: {text(object(source.source).kind)}{" "}
                        {typeof object(source.source).pointer === "string"
                          ? String(object(source.source).pointer)
                          : ""}
                        {object(source.source).confirmed === true ? " · confirmed by you" : ""}
                      </Typography>
                    )}
                  </Box>
                );
              })}
              <Divider />
              <Typography variant="subtitle1">Final documents</Typography>
              <Button
                component="a"
                href={absoluteApiUrl(`/api/personal/${record.id}/pdf`)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpenedHash(current.packetHash)}
              >
                Open exact resume PDF
              </Button>
              <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                Resume version: {text(document.sha256)}
              </Typography>
              {attachments.map((attachment) => (
                <Box key={String(attachment.id)}>
                  <Link
                    href={absoluteApiUrl(
                      `/api/personal/attachments/${record.id}/${String(attachment.sha256)}/pdf`,
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {text(attachment.label ?? attachment.kind)}
                  </Link>
                  <Typography variant="caption" sx={{ display: "block", overflowWrap: "anywhere" }}>
                    Version: {text(attachment.sha256)} ·{" "}
                    {attachment.review ? "Reviewed" : "Review pending"}
                  </Typography>
                </Box>
              ))}
              {requirements.map((requirement) => (
                <Typography key={String(requirement.fieldName)} variant="body2">
                  {text(requirement.label)}: {requirement.required ? "Required" : "Optional"}
                </Typography>
              ))}
              {Object.keys(email).length > 0 && (
                <Box>
                  <Typography variant="subtitle1">Official application email</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                    {text(email.recipient ?? email.to)}
                    {"\n"}
                    {text(email.subject)}
                    {"\n"}
                    {text(email.body ?? email.text)}
                  </Typography>
                </Box>
              )}
              <Typography variant="body2" color="text.secondary">
                Changes to the posting, facts, answers, files, requirements or campaign require
                another review. Withdrawing approval stops future work but cannot retract
                information already transmitted.
              </Typography>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          Close
        </Button>
        {activeApproval && current?.approval && input && (
          <Button
            color="warning"
            disabled={busy}
            onClick={() =>
              withdraw.mutate({ ...input, approvalId: current.approval!.id, recordId: record.id })
            }
          >
            Withdraw approval
          </Button>
        )}
        {!activeApproval && (
          <Button
            variant="contained"
            disabled={
              busy ||
              !packet ||
              !input ||
              !!current?.blockers.length ||
              openedHash !== current?.packetHash
            }
            onClick={() => input && approve.mutate(input)}
          >
            Approve this application
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
