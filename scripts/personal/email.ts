import type { PersonalCampaignNextResponse } from "../../packages/contracts/src/personal-campaign";

type Leased = Extract<PersonalCampaignNextResponse, { status: "task" }>;
export interface EmailExecution {
  leased: Leased;
  dispatchRequested: boolean;
  startedAt: number;
  checkAfter?: number;
  reconcileAttempts?: number;
  reconcileAfter?: number;
  parkAttempts?: number;
  parkAfter?: number;
}
interface State {
  emailCurrent?: EmailExecution;
  status: string;
}
export async function advanceApplicationEmail(
  state: State,
  api: (route: string, body?: unknown) => Promise<unknown>,
  persist: () => Promise<void>,
): Promise<void> {
  const current = state.emailCurrent;
  if (!current) return;
  const now = Date.now();
  if (now < (current.checkAfter ?? 0)) return;
  current.checkAfter = now + 30_000;
  await persist();
  const id = current.leased.attempt.id;
  const lease = {
    leaseOwner: current.leased.attempt.leaseOwner,
    leaseGeneration: current.leased.attempt.leaseGeneration,
  };
  const route = `/personal/attempts/${id}`;
  type Observed = {
    state: string;
    leaseOwner: string;
    leaseGeneration: number;
    leaseExpiresAt?: string;
  };
  const read = async (): Promise<Observed> => {
    const value = (await api(route)) as Observed | null;
    if (
      !value ||
      typeof value.state !== "string" ||
      typeof value.leaseOwner !== "string" ||
      !value.leaseOwner ||
      !Number.isSafeInteger(value.leaseGeneration) ||
      value.leaseGeneration < 1 ||
      (value.leaseExpiresAt !== undefined && !Number.isFinite(Date.parse(value.leaseExpiresAt)))
    )
      throw new Error("Application email attempt status could not be verified");
    return value;
  };
  const ownLease = (value: Observed) =>
    value.leaseOwner === lease.leaseOwner && value.leaseGeneration === lease.leaseGeneration;
  /**
   * A known-expired lease: no sender can still hold authority over the attempt, while the
   * server's durable reservation keeps guarding against duplicates. An absent expiry is not
   * positive proof of expiry (malformed values make read() throw) — fail closed and keep
   * tracking; a live lease, ours or a foreign sender's, may still shelter an in-flight send.
   */
  const leaseExpired = (value: Observed) =>
    value.leaseExpiresAt !== undefined && Date.parse(value.leaseExpiresAt) <= now;
  const settled = (value: Observed, providerStatus?: string) => {
    if (value.state === "submitted")
      state.status = "Employer acknowledgment recorded for the application email";
    else if (value.state === "submission_uncertain") {
      if (["provider_accepted", "provider_sent_verified"].includes(providerStatus ?? ""))
        state.status =
          "Application email provider receipt recorded; employer acknowledgment is pending. Resending is disabled.";
      else
        state.status =
          "Application email outcome is uncertain; reconciliation is required. Resending is disabled.";
    } else if (["blocked", "failed", "cancelled", "previewed"].includes(value.state))
      state.status = `Application email held: ${value.state}`;
    else if (["preparing", "prepared"].includes(value.state) && !ownLease(value))
      state.status = "Application email lease changed; local dispatch stopped";
    else return false;
    state.emailCurrent = undefined;
    return true;
  };
  /**
   * Stop local tracking of an unresolved attempt and free the global scheduler slot. The
   * release is read-only — it never dispatches, reconciles, or parks — so it cannot cause a
   * resend, and the durable server reservation for the observed state remains in force.
   */
  const releaseUnresolved = (facet: string, budget: string, observedState: string): void => {
    state.status = `Application email ${facet} is unresolved after bounded ${budget}; attempt state "${observedState}" stays recorded on the server reservation, local scheduler tracking is released, and resending stays disabled`;
    state.emailCurrent = undefined;
  };
  const park = async (reason: string) => {
    if ((current.parkAttempts ?? 0) >= 3) {
      const latest = await read();
      if (!leaseExpired(latest)) {
        state.status = "Application email recovery remains unresolved; no automatic resend";
        return;
      }
      releaseUnresolved("recovery", "recovery attempts", latest.state);
      return;
    }
    if (now < (current.parkAfter ?? 0)) {
      state.status = "Application email recovery remains unresolved; no automatic resend";
      return;
    }
    current.parkAttempts = (current.parkAttempts ?? 0) + 1;
    current.parkAfter = now + 60_000 * 2 ** (current.parkAttempts - 1);
    await persist();
    try {
      await api(`${route}/park`, { ...lease, kind: "blocked", reason });
    } catch (error) {
      if (settled(await read())) return;
      throw error;
    }
    if (!settled(await read()))
      state.status = "Application email recovery remains unresolved; no automatic resend";
  };
  const observed = await read();
  if (["submitting", "submission_uncertain"].includes(observed.state)) {
    if (now < (current.reconcileAfter ?? 0)) {
      if (!settled(observed))
        state.status = "Application email reconciliation is pending; no automatic resend";
      return;
    }
    if ((current.reconcileAttempts ?? 0) >= 3) {
      // Budget spent and still unresolved: release local tracking only on a known-expired
      // lease — a live lease, ours or a foreign sender's, may still shelter an in-flight send.
      if (!settled(observed)) {
        if (!leaseExpired(observed)) {
          state.status = "Application email reconciliation is pending; no automatic resend";
          return;
        }
        releaseUnresolved("reconciliation", "reconciliation", observed.state);
      }
      return;
    }
    current.reconcileAttempts = (current.reconcileAttempts ?? 0) + 1;
    current.reconcileAfter = now + 60_000 * 2 ** (current.reconcileAttempts - 1);
    current.checkAfter = current.reconcileAfter;
    await persist();
    let receipt: { status?: string };
    try {
      receipt = (await api(`/personal/application-email/attempts/${id}/reconcile`, {})) as {
        status?: string;
      };
    } catch (error) {
      if (settled(await read())) return;
      throw error;
    }
    if (!settled(await read(), receipt.status))
      state.status = "Application email reconciliation remains unresolved; no automatic resend";
    return;
  }
  if (settled(observed)) return;
  if (observed.state !== "prepared") {
    if (!leaseExpired(observed)) {
      state.status = "Application email state is unresolved; dispatch remains held";
      return;
    }
    releaseUnresolved("state", "state inspection", observed.state);
    return;
  }
  if (observed.leaseExpiresAt && Date.parse(observed.leaseExpiresAt) <= now) {
    state.status = "Application email preparation lease expired; dispatch stopped";
    state.emailCurrent = undefined;
    return;
  }
  if (current.dispatchRequested) {
    await park(
      "Interrupted email dispatch before confirmed submission; inspect the frozen transport before recovering",
    );
    return;
  }
  current.dispatchRequested = true;
  await persist();
  const result = (await api(`/personal/application-email/attempts/${id}/dispatch`, lease)) as {
    status: string;
  };
  const latest = await read();
  if (result.status === "blocked") {
    if (latest.state === "prepared" && ownLease(latest)) {
      await park("Application email account setup requires attention");
      return;
    }
  }
  if (!settled(latest, result.status))
    state.status = "Application email dispatch remains unresolved; no automatic resend";
}
