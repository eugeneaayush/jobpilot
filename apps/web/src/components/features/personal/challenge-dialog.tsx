"use client";

import { type ReactElement, useState } from "react";
import type { personalChallengeResponseSchema } from "@jobpilot/contracts/personal-challenge";
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
import { API_BASE_URL } from "@/api/base-url";
import { api } from "@/api/client";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { RelativeTime } from "@/components/ui/display";
import { useToast } from "@/providers/notification-provider";

interface ChallengeDialogProps {
  attemptId: string | null;
  open: boolean;
  onClose: () => void;
}

/** The contract exports DTO types for the parts we name; the response envelope derives here. */
type ChallengeResponse = z.infer<typeof personalChallengeResponseSchema>;
type ChallengeBody = NonNullable<ChallengeResponse["challenge"]>;

interface VerifyOutcome {
  status: "submitted" | "submission_uncertain";
  receiptHash?: string;
  needsUser?: string;
}

const CODE_PATTERN = /^[a-zA-Z0-9]{8}$/;

/**
 * Post-submit email verification. The application stays reserved behind the challenge fence;
 * only an explicitly typed 8-character code, sent once with a private bearer, can advance it.
 * A public confirmation page alone is never treated as a receipt.
 */
export function ChallengeDialog(props: ChallengeDialogProps): ReactElement {
  const { attemptId, open, onClose } = props;
  const toast = useToast();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);

  const challenge = useApiQuery(
    personalQueries.challenge(attemptId ?? "00000000-0000-0000-0000-000000000000"),
    { enabled: attemptId !== null, retry: false },
  );
  const data = challenge.data;

  /** Terminal PAT acquired like the handoff flow — memory only, destination is the API. */
  const verify = (): void => {
    const current = data?.challenge;
    if (!attemptId || !current || !CODE_PATTERN.test(code) || pending) return;
    setPending(true);
    api.auth.tokens.terminal
      .post()
      .then(async ({ data: tokenData, error }) => {
        if (error || !tokenData) {
          throw new Error("couldn't get a private token for verification");
        }
        const response = await fetch(
          `${API_BASE_URL}/api/personal/attempts/${attemptId}/challenge/verify`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${tokenData.token}`,
            },
            body: JSON.stringify({ challengeId: current.challengeId, code }),
          },
        );
        // The field clears the moment the request leaves the browser (and on any error path);
        // the local service separately retains mode-0600 request evidence for hash binding.
        setCode("");
        if (!response.ok) {
          throw new Error(`Verification failed (HTTP ${response.status})`);
        }
        setOutcome((await response.json()) as VerifyOutcome);
        return challenge.refetch();
      })
      .catch((error: unknown) => {
        setCode("");
        toast.error(error instanceof Error ? error.message : "Verification failed");
      })
      .finally(() => setPending(false));
  };

  const current: ChallengeBody | null = data?.challenge ?? null;
  // Escape, backdrop, and the Close button all drop the typed credential with the dialog.
  const close = (): void => {
    setCode("");
    onClose();
  };
  // Only an awaiting-user challenge with a verified recipient takes a typed code; captcha
  // retries and every other state are browser/manual-review work, never code entry.
  const codeEntryAllowed =
    current !== null &&
    current.status === "awaiting_user" &&
    current.hasRecipient &&
    current.code !== "captcha-retry";
  const codeValid = CODE_PATTERN.test(code);

  return (
    <Dialog open={open && attemptId !== null} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Email verification</DialogTitle>
      <DialogContent>
        {!data ? (
          challenge.isLoading ? (
            <LinearProgress />
          ) : (
            <Typography variant="body2Muted">No post-submit challenge on this attempt.</Typography>
          )
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {current ? (
              <Alert severity="info">
                This application remains reserved while the challenge is pending — the submission is
                fenced, not lost. Nothing is re-sent or retried automatically.
              </Alert>
            ) : (
              <Alert severity="info">No challenge is pending on this attempt.</Alert>
            )}
            {current && (
              <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
                <Chip size="small" variant="outlined" label={current.status} />
                <Chip size="small" variant="outlined" label={current.code} />
                {current.hasRecipient ? (
                  <Chip
                    size="small"
                    color="success"
                    variant="outlined"
                    label="recipient verified"
                  />
                ) : (
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label="no verified recipient"
                  />
                )}
                <RelativeTime value={current.createdAt} />
              </Stack>
            )}
            {current && !codeEntryAllowed && (
              <Alert severity="warning">
                {current.code === "captcha-retry"
                  ? "This challenge needs the browser captcha again — complete it in the challenge browser, then refresh status here."
                  : !current.hasRecipient
                    ? "No verified email recipient is on file for this challenge; it needs manual review rather than a typed code."
                    : "This challenge is not awaiting your input right now — refresh status or resolve it in the challenge browser."}
              </Alert>
            )}
            {current && codeEntryAllowed && (
              <Stack spacing={1}>
                <TextField
                  type="password"
                  label="Security code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8))}
                  disabled={pending}
                  helperText="Exactly 8 letters/digits from the verification email. Sent once to Greenhouse through your local service; cleared from this field afterward. Protected request evidence stays on this computer."
                  fullWidth
                  autoComplete="off"
                />
                <Button variant="contained" disabled={!codeValid || pending} onClick={verify}>
                  Verify once
                </Button>
              </Stack>
            )}
            {outcome && (
              <Alert severity={outcome.status === "submitted" ? "success" : "warning"}>
                {outcome.status === "submitted" ? (
                  <>
                    Verified submitted — the server verified a receipt correlated with your request
                    (evidence {outcome.receiptHash?.slice(0, 16) ?? "pending"}). A public
                    confirmation page alone is not a receipt.
                  </>
                ) : (
                  <>
                    Submission uncertain — the outcome is not verified, and no retry or recovery is
                    offered here. Reconcile the attempt first.
                  </>
                )}
                {outcome.needsUser && ` ${outcome.needsUser}`}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
        <Button disabled={challenge.isFetching} onClick={() => void challenge.refetch()}>
          Refresh status
        </Button>
      </DialogActions>
    </Dialog>
  );
}
