"use client";

import type { ReactElement } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";

interface FitEvidenceDialogProps {
  record: PersonalRecordDto;
  onClose: () => void;
}

export function FitEvidenceDialog(props: FitEvidenceDialogProps): ReactElement {
  const { record, onClose } = props;
  const fit = record.fitEvaluation;
  const groups = fit
    ? ([
        ["Supported and present in the draft", fit.supportedInDraft],
        ["Supported but omitted from the draft", fit.supportedButOmitted],
        ["Absent from accepted source facts", fit.absentFromBase],
        ["Supported in the accepted base", fit.supportedByBase],
        [
          "Insufficient evidence",
          fit.insufficientEvidence.map((item) => item.replaceAll("_", " ")),
        ],
      ] as const)
    : [];
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Fit evidence — {record.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="info">
            Fit {record.fitScore ?? "unavailable"} ranks eligible jobs. It does not grant
            eligibility or prevent a low-fit eligible job from being scheduled.
          </Alert>
          {record.fitReasons.map((reason) => (
            <Typography key={reason} variant="body2">
              {reason}
            </Typography>
          ))}
          {!fit && (
            <Typography>No current gap analysis. Reassess this posting to create one.</Typography>
          )}
          {groups.map(([label, terms]) => (
            <Stack key={label} spacing={0.5}>
              <Typography variant="subtitle2">{label}</Typography>
              <Typography variant="body2">{terms.join(", ") || "None recorded"}</Typography>
            </Stack>
          ))}
          {fit && (
            <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
              Method {fit.version} · source {fit.resumeHash} · posting {fit.postingHash}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
