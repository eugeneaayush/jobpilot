import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paginated } from "../../packages/contracts/src/pagination";
import type { PersonalRecordDto } from "../../packages/contracts/src/personal";
import type {
  PersonalCampaign,
  PersonalCampaignNextResponse,
} from "../../packages/contracts/src/personal-campaign";
import { personalSourceIdentity } from "../../packages/contracts/src/personal-source";
import {
  apiRequest,
  LocalHttpError,
  privateWrite,
  type RuntimeConfig,
  readConfig,
  runtimeRoot,
} from "./common";
import { type DigestPollState, tickDigest } from "./digest";
import { advanceApplicationEmail, type EmailExecution } from "./email";
import { type PilotDiscoveryState, tickPilotDiscovery } from "./pilot-discovery";
import {
  checkCooldown,
  delayRequest,
  idlePoll,
  newPollingState,
  type PollingState,
  requestBucket,
  sourcePoll,
} from "./polling";

type Request = {
  taskId: string;
  role: "supervisor" | "worker";
  adapter: "codex" | "claude" | "mock";
  kind: string;
  input: Record<string, unknown>;
};
type Snapshot = {
  status: string;
  result?: { nextAction?: string };
  submissionPossible?: boolean;
  codexSupervisorEnabled?: boolean;
};
type AttemptSnapshot = {
  state: string;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt?: string;
  submitAt?: string | null;
  receipt?: { outcome?: string } | null;
};
type Leased = Extract<PersonalCampaignNextResponse, { status: "task" }>;
type State = {
  owner: string;
  discoveries: Record<string, number>;
  polling?: PollingState;
  campaignCache?: PersonalCampaign[];
  emailCurrent?: EmailExecution;
  digest?: DigestPollState;
  discovery?: PilotDiscoveryState;
  preparationHolds?: Record<string, { updatedAt: string; nextAt: number; runId: string }>;
  preparationContinuations?: Record<string, { recordId: string; runId: string; advances: number }>;
  current?: {
    leased: Leased;
    request: Request;
    phase: "supervisor" | "worker";
    startedAt: number;
    resumeAttempts?: number;
    resumeAfter?: number;
    cancelAttempts?: number;
    cancelAfter?: number;
    attemptCancelAttempts?: number;
    attemptCancelAfter?: number;
    stopRequested?: boolean;
    submissionPossible?: boolean;
  };
  updatedAt: string;
  status: string;
  error?: string;
};
const statePath = path.join(runtimeRoot, "supervisor.json");
const lockPath = path.join(runtimeRoot, "supervisor.owner");
const terminalOrigin = "http://127.0.0.1:4102";
const endedStatuses = new Set([
  "completed",
  "failed",
  "blocked",
  "needs_user",
  "cancelled",
  "timed_out",
  "outcome_unknown",
  "interrupted",
]);
let stopping = false;

class LocalWorkerHttpError extends LocalHttpError {
  constructor(
    status: number,
    readonly workerBusy: boolean,
    route: string,
    method: string,
    retryAfter: string | null,
  ) {
    super(status, "terminal", route, method, retryAfter);
  }
}

async function terminal(
  config: RuntimeConfig,
  route: string,
  body?: unknown,
): Promise<Snapshot & { brokerConfigured?: boolean }> {
  const response = await fetch(`${terminalOrigin}/workers${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${config.account.token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new LocalWorkerHttpError(
      response.status,
      response.status === 409 && problem.detail === "This user's worker slot is already active.",
      route,
      body === undefined ? "GET" : "POST",
      response.headers.get("retry-after"),
    );
  }
  return response.json() as Promise<Snapshot & { brokerConfigured?: boolean }>;
}

function clients(config: RuntimeConfig, state: State, persist: (state: State) => Promise<void>) {
  state.polling ??= newPollingState();
  const polling = state.polling;
  const budgeted = async <T>(
    service: "api" | "terminal",
    route: string,
    body: unknown,
    work: () => Promise<T>,
  ) => {
    const bucket = requestBucket(service, body === undefined ? "GET" : "POST", route);
    checkCooldown(polling, bucket);
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof LocalHttpError &&
        error.retryScope !== "source" &&
        (error.status === 429 || error.retryAt !== undefined)
      ) {
        delayRequest(
          polling,
          bucket,
          Math.max(Date.now() + 1000, error.retryAt ?? Date.now() + 30_000),
        );
        await persist(state);
      }
      throw error;
    }
  };
  return {
    api: (route: string, body?: unknown) =>
      budgeted("api", route, body, () => apiRequest(config, route, body)),
    worker: (route: string, body?: unknown) =>
      budgeted("terminal", route, body, () => terminal(config, route, body)),
  };
}

async function ownLock(): Promise<void> {
  const candidate = `${lockPath}.${process.pid}.${crypto.randomUUID()}`;
  await writeFile(candidate, String(process.pid), { mode: 0o600 });
  try {
    await link(candidate, lockPath); // Atomic publication: readers never see an empty owner file.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error("Invalid supervisor owner file; inspect private runtime before restarting");
    try {
      process.kill(pid, 0);
      throw new Error("Another local supervisor owns this runtime");
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check;
    }
    await rm(lockPath);
    await link(candidate, lockPath);
  } finally {
    await rm(candidate);
  }
}

async function save(state: State): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const temporary = `${statePath}.${process.pid}.tmp`;
  await privateWrite(temporary, state);
  await rename(temporary, statePath);
}

async function cancelOrProbe(
  config: RuntimeConfig,
  state: State,
  persist: (state: State) => Promise<void>,
): Promise<Snapshot | undefined> {
  const { worker } = clients(config, state, persist);
  const current = state.current;
  if (!current) return;
  const route = `/tasks/${current.request.taskId}`;
  const cooldown =
    state.polling?.cooldowns[requestBucket("terminal", "POST", `${route}/cancel`)] ?? 0;
  if (
    (current.cancelAttempts ?? 0) >= 3 ||
    Date.now() < Math.max(current.cancelAfter ?? 0, cooldown)
  )
    return worker(route).catch(() => undefined);
  current.cancelAttempts = (current.cancelAttempts ?? 0) + 1;
  current.cancelAfter = Date.now() + 30_000 * 2 ** (current.cancelAttempts - 1);
  await persist(state); // Count before sending: a lost reply must not reset the retry budget.
  return worker(`${route}/cancel`, {}).catch(() => undefined);
}

async function activeCampaigns(
  config: RuntimeConfig,
  state: State,
  persist: (state: State) => Promise<void>,
): Promise<PersonalCampaign[]> {
  const { api } = clients(config, state, persist);
  const all: PersonalCampaign[] = [];
  for (let page = 1; ; page++) {
    const result = (await api(
      `/personal/campaigns?status=active&page=${page}&limit=100`,
    )) as Paginated<PersonalCampaign>;
    all.push(...result.items);
    if (all.length >= result.pagination.total || !result.items.length) return all;
  }
}

export async function advance(
  config: RuntimeConfig,
  state: State,
  active: PersonalCampaign[] | undefined,
  persist: (state: State) => Promise<void> = save,
): Promise<void> {
  try {
    await advanceReserved(config, state, active, persist);
  } catch (error) {
    if (
      state.current?.phase === "worker" &&
      error instanceof LocalWorkerHttpError &&
      error.workerBusy
    ) {
      state.status = "Waiting for the exclusive browser profile; reserved work remains queued";
      return;
    }
    throw error;
  }
}

async function advanceReserved(
  config: RuntimeConfig,
  state: State,
  active: PersonalCampaign[] | undefined,
  persist: (state: State) => Promise<void>,
): Promise<void> {
  const { api, worker } = clients(config, state, persist);
  const current = state.current;
  if (!current) return;
  const lease = {
    leaseOwner: current.leased.attempt.leaseOwner,
    leaseGeneration: current.leased.attempt.leaseGeneration,
  };
  const attemptPath = `/personal/attempts/${current.leased.attempt.id}`;
  const ownsLease = (attempt: AttemptSnapshot) =>
    attempt.leaseOwner === lease.leaseOwner && attempt.leaseGeneration === lease.leaseGeneration;
  const canParkEndedTask = (attempt: AttemptSnapshot, submissionOnly = false) =>
    ownsLease(attempt) &&
    ((!submissionOnly && ["preparing", "prepared"].includes(attempt.state)) ||
      (current.phase === "worker" && attempt.state === "submitting"));
  const parkIfOwned = async (
    kind: "blocked" | "failed",
    reason: string,
    submissionOnly = false,
  ) => {
    const read = () => api(attemptPath) as Promise<AttemptSnapshot>;
    const before = await read();
    if (!canParkEndedTask(before, submissionOnly)) return before;
    try {
      await api(`${attemptPath}/park`, { ...lease, kind, reason });
    } catch (error) {
      const after = await read();
      if (!canParkEndedTask(after, submissionOnly)) return after;
      throw error;
    }
    return read();
  };
  const settled = (attempt: AttemptSnapshot) => {
    if (attempt.state === "submitted" && attempt.receipt?.outcome === "submitted")
      state.status = "Submission confirmation recorded";
    else if (attempt.state === "submission_uncertain")
      state.status = "Submission outcome is uncertain; reconciliation required before retrying";
    else if (["blocked", "failed", "cancelled", "previewed"].includes(attempt.state))
      state.status = `Application requires attention: ${attempt.state}`;
    else return false;
    return true;
  };
  const releaseRetiredPreparation = async (attempt: AttemptSnapshot) => {
    if (
      current.submissionPossible ||
      !["preparing", "prepared"].includes(attempt.state) ||
      attempt.submitAt !== null ||
      attempt.receipt !== null ||
      typeof attempt.leaseOwner !== "string" ||
      !attempt.leaseOwner ||
      !Number.isSafeInteger(attempt.leaseGeneration) ||
      attempt.leaseGeneration < 1 ||
      (ownsLease(attempt) && !(Date.parse(attempt.leaseExpiresAt ?? "") <= Date.now()))
    )
      return false;
    // Only forget the local task; the API must reconcile the expired reservation on /next.
    state.current = undefined;
    state.status =
      "Preparation lease expired or changed; next reservation will reconcile it before retrying";
    await persist(state);
    return true;
  };
  const rememberPossibleSubmission = async (snapshot: Snapshot | undefined) => {
    if (snapshot?.submissionPossible === true && !current.submissionPossible) {
      current.submissionPossible = true;
      await persist(state);
    }
  };
  if (
    current.stopRequested ||
    (active !== undefined &&
      !active.some((campaign) => campaign.id === current.leased.campaignId)) ||
    Date.now() - current.startedAt > 15 * 60_000
  ) {
    current.stopRequested = true;
    state.status = "Stopping task; waiting for an authoritative application outcome";
    const cancellation = await cancelOrProbe(config, state, persist);
    await rememberPossibleSubmission(cancellation);
    const ended = cancellation !== undefined && endedStatuses.has(cancellation.status);
    const read = () => api(attemptPath) as Promise<AttemptSnapshot>;
    let attempt = await read();
    if (current.submissionPossible && ["preparing", "prepared"].includes(attempt.state)) {
      state.status = "Worker reported a possible submission; authoritative reconciliation required";
      return;
    }
    if (await releaseRetiredPreparation(attempt)) return;
    if (ownsLease(attempt) && ["preparing", "prepared"].includes(attempt.state)) {
      if (
        (current.attemptCancelAttempts ?? 0) < 3 &&
        Date.now() >= (current.attemptCancelAfter ?? 0)
      ) {
        checkCooldown(state.polling!, requestBucket("api", "POST", `${attemptPath}/cancel`));
        current.attemptCancelAttempts = (current.attemptCancelAttempts ?? 0) + 1;
        current.attemptCancelAfter = Date.now() + 30_000 * 2 ** (current.attemptCancelAttempts - 1);
        await persist(state);
        try {
          await api(`${attemptPath}/cancel`, lease);
        } catch (error) {
          attempt = await read();
          if (
            error instanceof LocalHttpError &&
            error.status === 409 &&
            (await releaseRetiredPreparation(attempt))
          )
            return;
          if (ownsLease(attempt) && ["preparing", "prepared"].includes(attempt.state)) throw error;
        }
        attempt = await read();
      } else if (ended) {
        try {
          attempt = await parkIfOwned(
            "blocked",
            "Local execution stopped after bounded cancellation",
          );
        } catch (error) {
          if (!(error instanceof LocalHttpError) || error.status !== 409) throw error;
          attempt = await read();
          if (await releaseRetiredPreparation(attempt)) return;
          throw error;
        }
      }
    }
    if (attempt.state === "submitting" && ended)
      attempt = await parkIfOwned(
        "blocked",
        "Local execution stopped without a submission receipt",
        true,
      );
    if (settled(attempt)) state.current = undefined;
    else if (await releaseRetiredPreparation(attempt)) return;
    else
      state.status =
        attempt.state === "submitting"
          ? "Stopping task; submission remains unresolved and requires reconciliation"
          : "Stopping task; application state remains unresolved";
    return;
  }
  const attemptState = (await api(attemptPath)) as AttemptSnapshot & {
    manifestHash: string;
  };
  if (
    (attemptState.state === "previewed" &&
      attemptState.manifestHash === current.leased.attempt.manifestHash) ||
    (attemptState.state === "submitted" && attemptState.receipt?.outcome === "submitted")
  ) {
    state.status =
      attemptState.state === "previewed"
        ? "Offline preview completion recovered"
        : "Submission confirmation recovered";
    state.current = undefined;
    return;
  }
  if (current.submissionPossible && ["preparing", "prepared"].includes(attemptState.state)) {
    state.status = "Worker reported a possible submission; authoritative reconciliation required";
    return;
  }
  if (
    ["preparing", "prepared"].includes(attemptState.state) &&
    (Date.parse(attemptState.leaseExpiresAt ?? "") <= Date.now() ||
      attemptState.leaseOwner !== lease.leaseOwner ||
      attemptState.leaseGeneration !== lease.leaseGeneration)
  ) {
    const cancellation = await cancelOrProbe(config, state, persist);
    await rememberPossibleSubmission(cancellation);
    const latest = (await api(attemptPath)) as AttemptSnapshot;
    if (await releaseRetiredPreparation(latest)) return;
    state.status =
      "Preparation lease changed; waiting for authoritative pre-submission or reconciliation evidence";
    return;
  }
  if (["preparing", "prepared"].includes(attemptState.state))
    await api(`${attemptPath}/checkpoint`, lease);
  else if (!["submitting", "submitted", "previewed"].includes(attemptState.state)) {
    await cancelOrProbe(config, state, persist);
    state.current = undefined;
    state.status = `Application requires attention: ${attemptState.state}`;
    return;
  }
  let result: Snapshot;
  try {
    result = await worker(`/tasks/${current.request.taskId}`);
  } catch (error) {
    if (!(error instanceof LocalWorkerHttpError) || error.status !== 404) throw error;
    const latest = (await api(attemptPath)) as AttemptSnapshot;
    if (!ownsLease(latest) || !["preparing", "prepared"].includes(latest.state)) {
      state.status = "Execution missing after submission boundary; waiting for reconciliation";
      return;
    }
    result = await worker("/tasks", current.request);
  }
  await rememberPossibleSubmission(result);
  if (["queued", "running", "cancelling"].includes(result.status)) {
    state.status =
      current.phase === "worker"
        ? "Execution worker processing one reserved application"
        : "Supervisor reviewing one bounded task";
    return;
  }
  if (
    result.status === "interrupted" &&
    result.submissionPossible === false &&
    ["preparing", "prepared"].includes(attemptState.state) &&
    (current.resumeAttempts ?? 0) < 2
  ) {
    if (Date.now() < (current.resumeAfter ?? 0)) {
      state.status = "Interrupted execution waiting for bounded resume backoff";
      return;
    }
    const latest = (await api(attemptPath)) as AttemptSnapshot;
    if (!ownsLease(latest) || !["preparing", "prepared"].includes(latest.state)) {
      state.status = "Interrupted execution state changed; waiting for authoritative recovery";
      return;
    }
    checkCooldown(
      state.polling!,
      requestBucket("terminal", "POST", `/tasks/${current.request.taskId}/resume`),
    );
    current.resumeAttempts = (current.resumeAttempts ?? 0) + 1;
    current.resumeAfter = Date.now() + 30_000 * 2 ** (current.resumeAttempts - 1);
    state.status = "Resuming interrupted preparation within the bounded retry budget";
    await persist(state);
    await worker(`/tasks/${current.request.taskId}/resume`, {});
    return;
  }
  if (
    current.phase === "supervisor" &&
    result.status === "completed" &&
    result.result?.nextAction === "dispatch_worker"
  ) {
    current.phase = "worker";
    current.resumeAttempts = 0;
    current.resumeAfter = 0;
    current.cancelAttempts = 0;
    current.cancelAfter = 0;
    current.attemptCancelAttempts = 0;
    current.attemptCancelAfter = 0;
    current.request = {
      taskId: crypto.randomUUID(),
      role: "worker",
      adapter: current.leased.mode === "offline" ? "mock" : "claude",
      kind: current.leased.mode === "offline" ? "prepare_apply" : "apply",
      input: {
        attemptId: current.leased.attempt.id,
        ...lease,
        task: "Complete only the reserved application using broker tools. Inspect required fields, use only immutable approved answers and PDF. Park unknown answers or security challenges. A receipt is required for submission.",
      },
    };
    await persist(state); // Persist identity before dispatch; replay is idempotent after a crash.
    await worker("/tasks", current.request);
    state.status = "Execution worker processing one reserved application";
    return;
  }
  if (
    current.leased.mode === "offline" &&
    current.phase === "worker" &&
    result.status === "completed"
  ) {
    await api(`${attemptPath}/finish-preview`, {
      ...lease,
      manifestHash: current.leased.attempt.manifestHash,
    });
    state.status = "Offline preview completed; no employer requests";
  } else {
    state.status = "Worker ended; waiting for an authoritative application outcome";
    const attempt = await parkIfOwned(
      result.status === "failed" ? "failed" : "blocked",
      `Local ${current.phase} outcome: ${result.status}`,
    );
    if (!settled(attempt)) {
      state.status =
        attempt.state === "submitting"
          ? "Worker ended while submission remains unresolved; waiting for reconciliation state"
          : "Worker ended; application state is unresolved and remains reserved";
      return;
    }
  }
  state.current = undefined;
}

function campaignSources(campaign: PersonalCampaign) {
  const instances = [
    ...campaign.sources.boardTokens.map((boardToken) => ({
      source: "greenhouse" as const,
      boardToken,
    })),
    ...(campaign.sources.instances ?? []),
  ];
  const sources = new Map<
    string,
    {
      source: "greenhouse" | "lever" | "ashby" | "cbs";
      boardToken: string;
      region?: "global" | "eu";
    }
  >();
  for (const item of instances) {
    const region = item.source === "lever" ? (item.region ?? "global") : undefined;
    const normalized = {
      source: item.source,
      boardToken: item.boardToken,
      ...(region && { region }),
    };
    sources.set(personalSourceIdentity(normalized), normalized);
  }
  return [...sources].map(([key, source]) => ({ key, ...source }));
}

async function prepareCandidates(
  config: RuntimeConfig,
  state: State,
  campaign: PersonalCampaign,
  persist: (state: State) => Promise<void>,
): Promise<void> {
  const { api } = clients(config, state, persist);
  const polling = state.polling!;
  const page = polling.preparations[campaign.id]?.page ?? 1;
  polling.preparations[campaign.id] = { attemptedAt: Date.now(), page };
  polling.preparationNextAt = Date.now() + 60_000;
  await persist(state);
  state.preparationHolds ??= {};
  state.preparationContinuations ??= {};
  let continuation: NonNullable<State["preparationContinuations"]>[string] | undefined =
    state.preparationContinuations[campaign.id];
  if (continuation?.runId !== (campaign.authorization?.runId ?? "")) {
    delete state.preparationContinuations[campaign.id];
    continuation = undefined;
  }
  let rows: PersonalRecordDto[] = [];
  if (continuation) {
    try {
      rows = [(await api(`/personal/${continuation.recordId}`)) as PersonalRecordDto];
    } catch (error) {
      if (!(error instanceof LocalHttpError) || error.status !== 404) throw error;
      delete state.preparationContinuations[campaign.id];
      continuation = undefined;
    }
  }
  if (!continuation) {
    const data = (await api(`/personal?page=${page}&limit=100`)) as {
      records: Paginated<PersonalRecordDto>;
    };
    rows = [...data.records.items].sort((a, b) => (b.fitScore ?? -1) - (a.fitScore ?? -1));
    polling.preparations[campaign.id]!.page =
      page * 100 >= data.records.pagination.total || !rows.length ? 1 : page + 1;
  }
  const sources = campaignSources(campaign);
  const holds = state.preparationHolds;
  const candidate = (row: PersonalRecordDto) => {
    const hold = holds[row.id];
    if (
      hold &&
      hold.updatedAt === new Date(row.updatedAt).toISOString() &&
      hold.runId === campaign.authorization?.runId &&
      hold.nextAt > Date.now()
    )
      return false;
    return (
      campaign.tracks.includes(row.track) &&
      sources.some((source) => row.identity.startsWith(`${source.key}:`)) &&
      !["undergraduate_entry", "unresolved"].includes(
        row.seniority?.classification ?? "unresolved",
      ) &&
      row.eligibility.decision !== "ineligible" &&
      ["discovered", "eligible", "prepared"].includes(row.state) &&
      (campaign.mode !== "submit" || row.eligibility.decision === "eligible")
    );
  };
  // Finish a bounded phase chain before paging; ready and blocked records yield their turn.
  for (const [index, row] of rows.entries()) {
    if (!candidate(row)) {
      delete state.preparationContinuations[campaign.id];
      continue;
    }
    let result: {
      status: string;
      phase: string;
      reason: string | null;
      nextEligibleAt?: string | null;
      recordUpdatedAt?: string;
    };
    try {
      result = (await api(`/personal/${row.id}/preparation`, {
        campaignId: campaign.id,
      })) as typeof result;
    } catch (error) {
      if (
        !(error instanceof LocalHttpError) ||
        ![404, 409].includes(error.status) ||
        error.retryAt !== undefined
      )
        throw error;
      state.preparationHolds[row.id] = {
        updatedAt: new Date(row.updatedAt).toISOString(),
        runId: campaign.authorization?.runId ?? "",
        nextAt: Date.now() + (error.status === 409 ? 60_000 : 3_600_000),
      };
      delete state.preparationContinuations[campaign.id];
      const next = rows.slice(index + 1).find(candidate);
      if (next)
        state.preparationContinuations[campaign.id] = {
          recordId: next.id,
          runId: campaign.authorization?.runId ?? "",
          advances: 0,
        };
      // A row conflict spends this minute's slot, but cannot monopolize its sorted page.
      state.status = `Document preparation deferred (HTTP ${error.status}); other records remain scheduled`;
      break;
    }
    state.preparationHolds[row.id] = {
      updatedAt: result.recordUpdatedAt ?? new Date(row.updatedAt).toISOString(),
      runId: campaign.authorization?.runId ?? "",
      nextAt:
        result.status === "ready"
          ? Number.MAX_SAFE_INTEGER
          : Date.parse(result.nextEligibleAt ?? "") || Date.now() + 3_600_000,
    };
    const advances = (continuation?.advances ?? 0) + 1;
    if (result.status === "pending" && result.reason === null && advances < 4) {
      state.preparationContinuations[campaign.id] = {
        recordId: row.id,
        runId: campaign.authorization?.runId ?? "",
        advances,
      };
    } else delete state.preparationContinuations[campaign.id];
    if (result.status === "ready")
      polling.campaigns[campaign.id] = { idleCount: 0, nextAt: Date.now() };
    state.status = `Document preparation ${result.status}: ${result.phase}${result.reason ? `; ${result.reason}` : ""}`;
    break;
  }
  await persist(state);
}

export async function cycle(
  config: RuntimeConfig,
  state: State,
  persist: (state: State) => Promise<void> = save,
): Promise<void> {
  state.digest ??= {};
  await tickDigest(config, state.digest, () => persist(state));
  state.polling ??= newPollingState();
  const polling = state.polling;
  // Campaign.stop revokes the attempt server-side. A failed/list-throttled read
  // must never suppress the current attempt's independent lease/status checks.
  if (state.current) {
    await advance(config, state, undefined, persist);
    if (!state.current) {
      polling.list = undefined;
      polling.scheduleNextAt = 0;
    }
    return;
  }
  const { api, worker } = clients(config, state, persist);
  if (state.emailCurrent) {
    const { api } = clients(config, state, persist);
    await advanceApplicationEmail(state, api, () => persist(state));
    await persist(state);
    return;
  }
  const now = Date.now();
  let active = state.campaignCache;
  if (!active || now >= (polling.list?.nextAt ?? 0)) {
    active = await activeCampaigns(config, state, persist);
    state.campaignCache = active;
    polling.list = idlePoll(polling.list, now);
    const present = new Set(active.map((campaign) => campaign.id));
    for (const id of Object.keys(polling.campaigns))
      if (!present.has(id)) delete polling.campaigns[id];
    for (const id of Object.keys(polling.preparations))
      if (!present.has(id)) {
        delete polling.preparations[id];
        delete state.preparationContinuations?.[id];
      }
  }
  if (!active.length) {
    state.status = "Idle; all campaigns stopped";
    return;
  }
  const campaign = active
    .filter((item) => now >= (polling.campaigns[item.id]?.nextAt ?? 0))
    .sort(
      (a, b) => (polling.campaigns[a.id]?.nextAt ?? 0) - (polling.campaigns[b.id]?.nextAt ?? 0),
    )[0];
  const scheduleDue = campaign && now >= (polling.scheduleNextAt ?? 0);
  try {
    const discoveryBucket = requestBucket("api", "POST", "/personal/discover");
    if (scheduleDue) {
      polling.scheduleNextAt = now + 15_000;
      await persist(state);
      for (const [board, attemptedAt] of Object.entries(state.discoveries))
        sourcePoll(polling, `greenhouse:${board}`, attemptedAt);
      state.discovery ??= {};
      await tickPilotDiscovery(state.discovery, polling, active, config.pilotDiscovery ?? {}, {
        api,
        persist: () => persist(state),
      });
    }
    const preparationBucket = requestBucket("api", "POST", "/personal/record/preparation");
    if (
      now >= (polling.preparationNextAt ?? 0) &&
      now >= (polling.cooldowns[discoveryBucket] ?? 0) &&
      now >= (polling.cooldowns[preparationBucket] ?? 0)
    ) {
      const preparation = [...active].sort(
        (a, b) =>
          (polling.preparations[a.id]?.attemptedAt ?? 0) -
          (polling.preparations[b.id]?.attemptedAt ?? 0),
      )[0]!;
      await prepareCandidates(config, state, preparation, persist);
    }
    if (!scheduleDue) return;
    const leased = (await api(`/personal/campaigns/${campaign.id}/next`, {
      leaseOwner: state.owner,
    })) as PersonalCampaignNextResponse;
    if (leased.status === "idle") {
      state.status = `Campaign waiting: ${leased.reasons.join("; ")}`;
      polling.campaigns[campaign.id] = idlePoll(polling.campaigns[campaign.id], Date.now());
      return;
    }
    if (campaign.mode === "submit" && leased.task.applicationMethod === "official_email") {
      state.emailCurrent = { leased, dispatchRequested: false, startedAt: Date.now() };
      state.status = "Dispatching one authorized official application email";
      await persist(state);
      await advanceApplicationEmail(state, api, () => persist(state));
      return;
    }
    if (campaign.mode === "submit") {
      const capabilities = await worker("/capabilities");
      if (
        !capabilities.brokerConfigured ||
        capabilities.codexSupervisorEnabled !== true ||
        config.providerApproval?.verified !== true ||
        !(
          config.providerApproval.allowApplicantData || config.providerApproval.allowMetadataOnly
        ) ||
        !config.providerApproval.provider ||
        !Bun.which("claude") ||
        !Bun.which("codex")
      ) {
        await api(`/personal/attempts/${leased.attempt.id}/park`, {
          leaseOwner: leased.attempt.leaseOwner,
          leaseGeneration: leased.attempt.leaseGeneration,
          kind: "blocked",
          reason:
            "Browser application requires verified provider, Claude/Codex, and scoped browser setup",
        });
        state.status =
          "Browser application held for verified provider, Claude/Codex, and scoped browser setup";
        polling.campaigns[campaign.id] = idlePoll(polling.campaigns[campaign.id], now);
        return;
      }
    }
    const request: Request = {
      taskId: crypto.randomUUID(),
      role: "supervisor",
      adapter: campaign.mode === "offline" ? "mock" : "codex",
      kind: "plan",
      input: {
        campaignId: campaign.id,
        mode: campaign.mode,
        record: leased.record,
        lease: leased.attempt,
        task: "Choose dispatch_worker for this server-validated reserved task, otherwise request_user. Do not access applicant files or expand the campaign scope.",
      },
    };
    polling.campaigns[campaign.id] = { idleCount: 0, nextAt: Date.now() + 15_000 };
    state.current = { leased, request, phase: "supervisor", startedAt: Date.now() };
    state.status = "Supervisor reviewing one bounded task";
    await persist(state);
    await worker("/tasks", request);
  } catch (error) {
    if (campaign)
      polling.campaigns[campaign.id] = idlePoll(polling.campaigns[campaign.id], Date.now());
    await persist(state);
    throw error;
  }
}

async function runPilot() {
  await ownLock();
  let state: State;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    state = {
      owner: `personal-${crypto.randomUUID()}`,
      discoveries: {},
      updatedAt: "",
      status: "Starting",
    };
  }
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  try {
    while (!stopping) {
      try {
        await cycle(await readConfig(), state);
        state.error = undefined;
      } catch {
        state.error = "Local supervisor could not advance; check doctor and private service logs";
      }
      await save(state);
      for (let second = 0; second < 15 && !stopping; second++) await Bun.sleep(1000);
    }
  } finally {
    if (state.current) await cancelOrProbe(await readConfig(), state, save);
    await save(state);
    await rm(lockPath, { recursive: true });
  }
}

if (import.meta.main) await runPilot();
