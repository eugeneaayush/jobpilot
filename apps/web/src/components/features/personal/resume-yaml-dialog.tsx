"use client";

import { type ReactElement, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueryKeys } from "@/api/personal";

interface ResumeYamlDialogProps {
  recordId: string;
  onClose: () => void;
}

export function ResumeYamlDialog(props: ResumeYamlDialogProps): ReactElement {
  const { recordId, onClose } = props;
  const bundle = useApiQuery(
    {
      queryKey: [...personalQueryKeys.all, "yaml", recordId],
      queryFn: () => api.personal({ id: recordId })["resume-yaml"].get(),
    },
    { staleTime: 0 },
  );
  const [edited, setEdited] = useState<string | null>(null);
  const imported = useApiMutation(
    (body: { recordVersion: string; bundleYaml: string }) =>
      api.personal({ id: recordId })["resume-yaml"].post(body),
    {
      invalidate: [personalQueryKeys.all],
      successMessage: "YAML changes proposed for independent review",
    },
  );
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Resume YAML bundle</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="info">
            This bundle preserves the accepted source and mapping. You can propose supported cuts,
            ordering and bullet phrasing. Imported changes require independent claim review and a
            newly verified document.
          </Alert>
          {bundle.error && <Alert severity="error">{bundle.error.message}</Alert>}
          {bundle.data && (
            <TextField
              label="JobPilot-produced YAML"
              multiline
              minRows={14}
              value={edited ?? bundle.data.bundleYaml}
              onChange={(event) => setEdited(event.target.value)}
            />
          )}
          {imported.data && (
            <Alert severity="success">
              Proposed {imported.data.structuralOperations} structural changes. Review the proposal
              before generating another PDF.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          disabled={!bundle.data || imported.isPending || edited === null}
          onClick={() =>
            bundle.data &&
            edited !== null &&
            imported.mutate({ recordVersion: bundle.data.recordVersion, bundleYaml: edited })
          }
        >
          Propose changes
        </Button>
      </DialogActions>
    </Dialog>
  );
}
