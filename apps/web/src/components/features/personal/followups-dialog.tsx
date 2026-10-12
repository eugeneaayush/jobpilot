"use client";

import { type ReactElement, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import {
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
  Stack,
  Typography,
} from "@mui/material";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueryKeys } from "@/api/personal";

interface FollowupsDialogProps {
  record: PersonalRecordDto;
  onClose: () => void;
}

const STATUS_LABELS = {
  drafted: "Draft saved",
  sent: "Sent receipt recorded",
  employer_confirmed: "Employer reply recorded",
  uncertain: "Delivery uncertain",
} as const;

export function FollowupsDialog({ record, onClose }: FollowupsDialogProps): ReactElement {
  const query = useApiQuery(
    {
      queryKey: [...personalQueryKeys.all, "followups", record.id],
      queryFn: () => api.personal.followups.records({ id: record.id }).get(),
    },
    { staleTime: 0, refetchOnWindowFocus: true },
  );
  const draft = useApiMutation(
    (recordVersion: string) =>
      api.personal.followups.records({ id: record.id }).post({ recordVersion }),
    {
      invalidate: [personalQueryKeys.all],
      successMessage: "Follow-up draft saved",
      onError: () => {
        void query.refetch();
      },
    },
  );
  const [copyResult, setCopyResult] = useState<string | null>(null);
  const current = query.data;
  const busy = query.isFetching || draft.isPending;

  const copy = async (subject: string, body: string) => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      setCopyResult("Draft copied. Nothing was sent.");
    } catch {
      setCopyResult("Copy is unavailable here. Select and copy the draft text below.");
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Follow-up — {record.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2">
            Prepare a draft from your submitted application after ten quiet days. At most two drafts
            are available for each application.
          </Typography>
          <Alert severity="info">
            Drafts stay here for your review. Creating or copying a draft does not send a message.
          </Alert>
          {query.isLoading && <CircularProgress aria-label="Loading follow-up drafts" />}
          {query.error && <Alert severity="error">{query.error.message}</Alert>}
          {current?.blocker && <Alert severity="info">{current.blocker}</Alert>}
          {current?.availableAt && !current.eligible && current.availableAt > new Date() && (
            <Typography variant="body2" color="text.secondary">
              Next available:{" "}
              {current.availableAt.toLocaleString("en-US", { timeZone: "America/New_York" })}{" "}
              Eastern.
            </Typography>
          )}
          {copyResult && (
            <Alert severity="info" onClose={() => setCopyResult(null)}>
              {copyResult}
            </Alert>
          )}
          {current?.drafts.map((item) => (
            <Box key={item.id}>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                  <Typography variant="subtitle1">Draft {item.ordinal}</Typography>
                  <Chip
                    label={STATUS_LABELS[item.status]}
                    color={item.status === "uncertain" ? "warning" : "default"}
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Saved {item.createdAt.toLocaleString("en-US", { timeZone: "America/New_York" })}{" "}
                  Eastern
                </Typography>
                <Typography variant="body2">
                  Recipient: {item.recipient ?? "No verified recipient saved"}
                </Typography>
                {!item.recipient && (
                  <Typography variant="body2" color="text.secondary">
                    Choose a verified contact when you review the draft.
                  </Typography>
                )}
                <Typography variant="subtitle2">{item.subject}</Typography>
                <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
                  {item.body}
                </Typography>
                <Box>
                  <Button onClick={() => void copy(item.subject, item.body)}>Copy draft</Button>
                </Box>
                <Divider />
              </Stack>
            </Box>
          ))}
          {current && current.drafts.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No follow-up drafts have been created for this application.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button
          variant="contained"
          disabled={busy || !current?.eligible}
          onClick={() => current && draft.mutate(current.recordVersion)}
        >
          Create follow-up draft
        </Button>
      </DialogActions>
    </Dialog>
  );
}
