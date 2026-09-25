"use client";

import { type ReactElement, useEffect, useState } from "react";
import type { PersonalHandoff } from "@jobpilot/contracts/personal-handoff";
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
  Typography,
} from "@mui/material";
import { api } from "@/api/client";
import { useApiQuery } from "@/api/hooks";
import { personalQueries } from "@/api/personal";
import { ColorChip, LabelValue, RelativeTime } from "@/components/ui/display";
import { useToast } from "@/providers/notification-provider";

interface HandoffDialogProps {
  attemptId: string | null;
  open: boolean;
  onClose: () => void;
}

// Mirrors the terminal origin in lib/terminal.ts; that module keeps its transport private.
const TERMINAL_HTTP_URL = process.env.NEXT_PUBLIC_TERMINAL_URL ?? "http://localhost:4102";

/** What the terminal host — not the API — says about the live handoff session. */
interface TerminalHandoffState {
  status: string;
  browserOpen: boolean;
  /** Authoritative lease generation; a higher value than the API view means our view is stale. */
  leaseGeneration?: number;
}

const STATUS_COLOR: Record<PersonalHandoff["status"], "default" | "info" | "success" | "warning"> =
  {
    parked: "warning",
    opening: "info",
    open: "info",
    resuming: "info",
    resolved: "success",
    cancelled: "default",
    expired: "default",
  };

const REASON_LABEL: Record<PersonalHandoff["reason"], string> = {
  login: "Login required",
  account_creation: "Account creation required",
  captcha: "Challenge / captcha required",
  terms: "Terms acceptance required",
  security_warning: "Security warning",
  verification: "Verification required",
};

/** A resumed handoff may still be open: the DTO decides the message, never the action name. */
function resumeMessage(status: string): string {
  return status === "resolved"
    ? "Handoff resolved — the terminal verified closure."
    : "Resume checked: the challenge remains pending. Finish it in the browser, then resume again.";
}

/**
 * The worker endpoints sit behind WorkerBearerFilter. The PAT is fetched from the API on
 * demand and held in memory only — the same pattern the terminal panel uses to start sessions.
 */
let tokenPromise: Promise<string> | null = null;

function terminalToken(): Promise<string> {
  tokenPromise ??= api.auth.tokens.terminal.post().then(({ data, error }) => {
    if (error || !data) {
      // A failed promise must not cache; the next action re-authenticates.
      tokenPromise = null;
      throw new Error(
        error?.value
          ? `couldn't get a terminal token (${error.value.message})`
          : "couldn't get a terminal token",
      );
    }
    return data.token;
  });
  return tokenPromise;
}

async function terminalFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await terminalToken();
  const response = await fetch(`${TERMINAL_HTTP_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    // The cached token expired: drop it so the NEXT user action re-authenticates. The failed
    // call is never replayed automatically — a consequential POST stays a single user act.
    tokenPromise = null;
  }
  return response;
}

/** Terminal GET carries the authoritative browserOpen state the API intentionally omits. */
async function fetchTerminalHandoff(attemptId: string): Promise<TerminalHandoffState> {
  const response = await terminalFetch(`/workers/handoffs/${attemptId}`);
  if (!response.ok) {
    throw new Error(`Terminal handoff lookup failed (HTTP ${response.status})`);
  }
  const body = (await response.json()) as Partial<TerminalHandoffState>;
  return {
    status: body.status ?? "unknown",
    browserOpen: body.browserOpen === true,
    leaseGeneration: body.leaseGeneration,
  };
}

/**
 * Login/security handoff for a stalled attempt. A handoff never authorizes submission: the
 * user performs credentials and challenges themselves in the headed browser, and Resume only
 * asks the terminal to verify closure. The terminal host owns the lease — posts carry no
 * lease body and every action reports what the returned DTO actually says.
 */
export function HandoffDialog(props: HandoffDialogProps): ReactElement {
  const { attemptId, open, onClose } = props;
  const toast = useToast();
  const [acting, setActing] = useState<"open" | "resume" | "cancel" | null>(null);
  const [terminalState, setTerminalState] = useState<TerminalHandoffState | null>(null);

  const handoff = useApiQuery(
    personalQueries.handoff(attemptId ?? "00000000-0000-0000-0000-000000000000"),
    { enabled: attemptId !== null, retry: false },
  );
  const data = handoff.data;

  const syncTerminalState = (id: string): void => {
    fetchTerminalHandoff(id)
      .then(setTerminalState)
      .catch(() => setTerminalState(null));
  };

  // The API reports browserOpen false by design; the live browser state comes from the host.
  // dataUpdatedAt is the trigger: re-sync whenever an action's refetch lands. syncTerminalState
  // is recreated per render, so listing it would loop — it only closes over setters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (attemptId !== null) {
      setTerminalState(null);
      syncTerminalState(attemptId);
    }
  }, [attemptId, handoff.dataUpdatedAt]);

  const act = (action: "open" | "resume" | "cancel"): void => {
    if (!attemptId) return;
    setActing(action);
    // No lease body: the host refreshes the authoritative lease and generation itself.
    terminalFetch(`/workers/handoffs/${attemptId}/${action}`, { method: "POST" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Terminal handoff ${action} failed (HTTP ${response.status})`);
        }
        const dto = (await response.json()) as Partial<TerminalHandoffState>;
        if (action === "open") {
          // Claim "opened" only when the returned DTO confirms the browser is actually up.
          toast.info(
            dto.browserOpen === true
              ? "Browser opened — complete the challenge yourself; it stays pending until you resume."
              : "Open requested — the host has not confirmed the browser yet. Refresh status to check.",
          );
        } else if (action === "resume") {
          toast.info(resumeMessage(dto.status ?? "unknown"));
        } else {
          toast.info("Handoff cancelled.");
        }
        syncTerminalState(attemptId);
        return handoff.refetch();
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Terminal handoff failed");
      })
      .finally(() => setActing(null));
  };

  const status = data?.status;
  // Reopen is a terminal capability for parked, expired, and cancelled handoffs.
  const canOpen = status === "parked" || status === "expired" || status === "cancelled";
  // API "open" alone is not enough after a host restart: the browser must actually be up.
  const browserLive = status === "open" && terminalState?.browserOpen === true;
  // A dead lease cannot verify closure, and a server-side renewal means this view is stale.
  const leaseExpired = data !== undefined && new Date(data.leaseExpiresAt).getTime() <= Date.now();
  const generationStale =
    data !== undefined &&
    terminalState?.leaseGeneration !== undefined &&
    terminalState.leaseGeneration > data.leaseGeneration;
  const canResume = browserLive && !leaseExpired && !generationStale;
  // Cancel stays available whenever offered: the host refreshes its own lease, and cancelling
  // a dead-lease handoff is safe cleanup the server accepts — never blindly disabled.
  const canCancel = status === "parked" || browserLive;

  /** Plain re-read of both views, so expiry/host recovery is observable without a reload. */
  const refreshStatus = (): void => {
    if (attemptId !== null) {
      syncTerminalState(attemptId);
      void handoff.refetch();
    }
  };

  return (
    <Dialog open={open && attemptId !== null} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Security handoff</DialogTitle>
      <DialogContent>
        {!data ? (
          handoff.isLoading ? (
            <LinearProgress />
          ) : (
            <Typography variant="body2Muted">No handoff is pending for this attempt.</Typography>
          )
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="info">
              A handoff does not authorize submission. You perform the credentials and challenges
              yourself in the opened browser; Resume only verifies the session is closed.
            </Alert>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              <ColorChip
                value={data.status}
                colors={STATUS_COLOR}
                label={data.status}
                variant="outlined"
              />
              <Chip
                size="small"
                color={terminalState?.browserOpen ? "success" : "default"}
                variant="outlined"
                label={terminalState?.browserOpen ? "browser open" : "browser closed"}
              />
              <Chip size="small" label={REASON_LABEL[data.reason]} />
            </Stack>
            {data.status === "open" && terminalState !== null && !terminalState.browserOpen && (
              <Alert severity="warning">
                The challenge browser is closed (for example after a host restart). Resume stays
                unavailable until the browser is open again — re-check or reopen from the
                terminal&apos;s worker state.
              </Alert>
            )}
            {leaseExpired && (
              <Alert severity="warning">
                The handoff lease has expired. Resume cannot verify closure on a dead lease —
                refresh status or reopen to renew it. Cancel remains available as safe cleanup.
              </Alert>
            )}
            {generationStale && data && terminalState?.leaseGeneration !== undefined && (
              <Alert severity="info">
                The lease was renewed server-side (generation {terminalState.leaseGeneration} vs{" "}
                {data.leaseGeneration} shown). Refresh status to load the current lease before
                resuming.
              </Alert>
            )}
            <Stack spacing={1}>
              <LabelValue label="Employer origin">
                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                  {data.allowedOrigin}
                </Typography>
              </LabelValue>
              <LabelValue label="Lease">
                <Typography variant="body2">
                  {data.leaseOwner} · generation {data.leaseGeneration}
                </Typography>
              </LabelValue>
              <LabelValue label="Lease expires">
                <RelativeTime value={data.leaseExpiresAt} variant="body2" />
              </LabelValue>
              {data.updatedAt && (
                <LabelValue label="Updated">
                  <RelativeTime value={data.updatedAt} variant="body2" />
                </LabelValue>
              )}
            </Stack>
            {data.events && data.events.length > 0 && (
              <Stack spacing={0.5}>
                <Typography variant="overlineMuted">Events</Typography>
                {data.events.map((event) => (
                  <Typography key={event.sequence} variant="captionMuted">
                    {event.type}: {event.message}
                  </Typography>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {data && (
          <Button onClick={refreshStatus} disabled={acting !== null}>
            Refresh status
          </Button>
        )}
        {data && canCancel && (
          <Button
            color="warning"
            variant="outlined"
            disabled={acting !== null}
            onClick={() => act("cancel")}
          >
            {acting === "cancel" ? "Cancelling…" : "Cancel handoff"}
          </Button>
        )}
        {data && canResume && (
          <Button variant="contained" disabled={acting !== null} onClick={() => act("resume")}>
            {acting === "resume" ? "Verifying…" : "Resume after challenge"}
          </Button>
        )}
        {data && canOpen && (
          <Button variant="contained" disabled={acting !== null} onClick={() => act("open")}>
            {acting === "open" ? "Opening…" : "Open browser for me"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
