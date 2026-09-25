import type { RuntimeConfig } from "./common";
import { cycle } from "./pilot";
import { newPollingState } from "./polling";
import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});
const config: RuntimeConfig = {
  apiEnv: {},
  sourceJsonPath: "",
  sourceDocxPath: "",
  comparisonPaths: [],
  candidate: {},
  boardToken: "fixture",
  account: { email: "synthetic@example.test", password: "unused", token: "synthetic" },
};
type State = Parameters<typeof cycle>[1];
function fixture(): State {
  return {
    owner: "synthetic",
    discoveries: {},
    polling: newPollingState(),
    digest: { nextCheckAt: Number.MAX_SAFE_INTEGER },
    updatedAt: "",
    status: "stopping",
    current: {
      phase: "worker",
      startedAt: Date.now(),
      stopRequested: true,
      request: { taskId: "task", role: "worker", adapter: "mock", kind: "apply", input: {} },
      leased: {
        status: "task",
        campaignId: "campaign",
        mode: "submit",
        attempt: {
          id: "attempt",
          leaseOwner: "owner",
          leaseGeneration: 1,
          manifestHash: "hash",
          state: "prepared",
        },
        record: {
          id: "record",
          identity: "fixture",
          title: "Synthetic",
          company: "Fixture",
          url: "https://example.test/job",
          track: "mba_internship",
        },
        task: { kind: "apply", attemptId: "attempt", brokerPath: "/synthetic" },
      },
    },
  };
}
function snapshot() {
  return {
    state: "prepared",
    submitAt: null as string | null,
    receipt: null,
    leaseOwner: "owner",
    leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

for (const operation of ["cancel", "park"] as const) {
  for (const retirement of ["expired", "replaced"] as const) {
    test(`stop releases only local tracking after ${operation} conflict proves ${retirement} pre-submit lease`, async () => {
      Date.now = () => 1_000_000;
      const state = fixture();
      if (operation === "park") state.current!.attemptCancelAttempts = 3;
      const stored = snapshot();
      let conflicts = 0;
      let persisted: State | undefined;
      const calls: string[] = [];
      globalThis.fetch = (async (input, init) => {
        const route = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${route}`);
        if (route.startsWith("/workers/tasks/task"))
          return Response.json({ status: "cancelled", submissionPossible: false });
        if (route === "/api/personal/attempts/attempt") return Response.json(stored);
        if (route === `/api/personal/attempts/attempt/${operation}`) {
          conflicts++;
          if (retirement === "expired") stored.leaseExpiresAt = new Date(0).toISOString();
          else {
            stored.leaseGeneration = 2;
            stored.leaseOwner = "replacement";
          }
          return new Response(null, { status: 409 });
        }
        if (route === "/api/personal/campaigns")
          return Response.json({ items: [], pagination: { total: 0 } });
        throw new Error(`Unexpected synthetic request ${route}`);
      }) as typeof fetch;
      await cycle(config, state, async (value) => {
        persisted = structuredClone(value);
      });
      expect(conflicts).toBe(1);
      expect(state.current).toBeUndefined();
      expect(persisted?.current).toBeUndefined();
      expect(state.status).toContain("next reservation will reconcile");
      expect(stored.state).toBe("prepared");
      expect(stored.submitAt).toBeNull();
      await cycle(config, state, async () => {});
      expect(calls).toContain("GET /api/personal/campaigns");
      expect(
        calls.filter((call) => call === `POST /api/personal/attempts/attempt/${operation}`),
      ).toHaveLength(1);
    });
  }
}

for (const unsafe of [
  "possible",
  "submitting",
  "submit_timestamp",
  "missing_submit_timestamp",
  "missing_receipt",
  "active_lease",
  "invalid_expiry",
  "read_failure",
]) {
  test(`stop retains identity after conflict with ${unsafe} evidence`, async () => {
    Date.now = () => 1_000_000;
    const state = fixture();
    const stored = snapshot();
    let conflicted = false;
    globalThis.fetch = (async (input) => {
      const route = new URL(String(input)).pathname;
      if (route.startsWith("/workers/tasks/task"))
        return Response.json({ status: "cancelled", submissionPossible: unsafe === "possible" });
      if (route === "/api/personal/attempts/attempt") {
        if (conflicted && unsafe === "read_failure") return new Response(null, { status: 503 });
        const value: Record<string, unknown> = { ...stored };
        if (conflicted) {
          value.leaseExpiresAt = new Date(0).toISOString();
          if (unsafe === "submitting") value.state = "submitting";
          if (unsafe === "submit_timestamp") value.submitAt = new Date(1).toISOString();
          if (unsafe === "missing_submit_timestamp") delete value.submitAt;
          if (unsafe === "missing_receipt") delete value.receipt;
          if (unsafe === "active_lease") value.leaseExpiresAt = stored.leaseExpiresAt;
          if (unsafe === "invalid_expiry") value.leaseExpiresAt = "invalid";
        }
        return Response.json(value);
      }
      if (route.endsWith("/cancel") || route.endsWith("/park")) {
        conflicted = true;
        return new Response(null, { status: 409 });
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await cycle(config, state, async () => {}).catch(() => undefined);
    expect(state.current?.request.taskId).toBe("task");
    expect(state.status).not.toContain("next reservation will reconcile");
  });
}

test("possible-submission evidence survives restart and cannot become an expired preparation release", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = fixture();
  const stored = snapshot();
  stored.leaseExpiresAt = new Date(0).toISOString();
  let possible = true;
  let saved = "";
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route.startsWith("/workers/tasks/task"))
      return Response.json({ status: "cancelled", submissionPossible: possible });
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route.endsWith("/cancel") || route.endsWith("/park"))
      return new Response(null, { status: 409 });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  const persist = async (value: State) => {
    saved = JSON.stringify(value);
  };
  await cycle(config, state, persist).catch(() => undefined);
  state = JSON.parse(saved);
  possible = false;
  now += 120_000;
  await cycle(config, state, persist).catch(() => undefined);
  expect(state.current?.request.taskId).toBe("task");
  expect(state.status).not.toContain("next reservation will reconcile");
});

test("an already expired pre-submit lease reaches the next scheduler reconciliation without API mutation", async () => {
  Date.now = () => 1_000_000;
  const state = fixture();
  state.polling!.preparationNextAt = Date.now() + 60_000;
  const stored = snapshot();
  stored.leaseExpiresAt = new Date(0).toISOString();
  const apiPosts: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route.startsWith("/workers/tasks/task"))
      return Response.json({ status: "cancelled", submissionPossible: false });
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (init?.method === "POST") apiPosts.push(route);
    if (route === "/api/personal/campaigns")
      return Response.json({
        items: [{ id: "campaign", mode: "offline", sources: { boardTokens: [] } }],
        pagination: { total: 1 },
      });
    if (route === "/api/personal/registry")
      return Response.json({ sources: [], pagination: { total: 0, totalPages: 0 } });
    if (route === "/api/personal/campaigns/campaign/next")
      return Response.json({ status: "idle", reasons: ["Synthetic reconciliation complete"] });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await cycle(config, state, async () => {});
  expect(state.current).toBeUndefined();
  expect(apiPosts).toEqual([]);
  await cycle(config, state, async () => {});
  expect(apiPosts).toEqual(["/api/personal/campaigns/campaign/next"]);
  expect(stored.state).toBe("prepared");
});

for (const scenario of [
  "expired",
  "replaced",
  "possible",
  "missing_receipt",
  "missing_submit_timestamp",
  "submit_timestamp",
  "submission_race",
  "read_failure",
]) {
  test(`ordinary stale lease uses fresh exact pre-submit proof: ${scenario}`, async () => {
    Date.now = () => 1_000_000;
    const state = fixture();
    state.current!.stopRequested = false;
    const stored: Record<string, unknown> = {
      ...snapshot(),
      leaseExpiresAt: new Date(0).toISOString(),
    };
    if (scenario === "replaced") {
      stored.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      stored.leaseOwner = "replacement";
      stored.leaseGeneration = 2;
    }
    if (scenario === "missing_receipt") delete stored.receipt;
    if (scenario === "missing_submit_timestamp") delete stored.submitAt;
    if (scenario === "submit_timestamp") stored.submitAt = new Date(1).toISOString();
    let cancelled = false;
    let saved: State | undefined;
    globalThis.fetch = (async (input) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/personal/attempts/attempt") {
        if (cancelled && scenario === "read_failure") return new Response(null, { status: 503 });
        return Response.json(stored);
      }
      if (route === "/workers/tasks/task/cancel") {
        cancelled = true;
        if (scenario === "submission_race") {
          stored.state = "submitting";
          stored.submitAt = new Date().toISOString();
        }
        return Response.json({ status: "cancelled", submissionPossible: scenario === "possible" });
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await cycle(config, state, async (value) => {
      saved = structuredClone(value);
    }).catch(() => undefined);
    const safe = ["expired", "replaced"].includes(scenario);
    expect(state.current === undefined).toBe(safe);
    expect(saved?.current === undefined).toBe(safe);
    if (scenario === "possible") expect(saved?.current?.submissionPossible).toBe(true);
  });
}
