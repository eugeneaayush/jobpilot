import type { RuntimeConfig } from "./common";
import { cycle } from "./pilot";
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
function stopped(): Parameters<typeof cycle>[1] {
  return {
    owner: "fixture-owner",
    discoveries: {},
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
        mode: "offline",
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
const persist = async () => {};

test("terminal cancellation cooldown survives restart without spending unsent retry attempts", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = stopped();
  let cancels = 0;
  let probes = 0;
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/workers/tasks/task/cancel") {
      cancels++;
      return new Response(null, { status: 429, headers: { "retry-after": "600" } });
    }
    if (route === "/workers/tasks/task") {
      probes++;
      return Response.json({ status: "running" });
    }
    if (route === "/api/personal/attempts/attempt")
      return Response.json({ state: "submitting", leaseOwner: "owner", leaseGeneration: 1 });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await cycle(config, state, persist);
  state = JSON.parse(JSON.stringify(state));
  now += 30_000;
  await cycle(config, state, persist);
  expect(cancels).toBe(1);
  expect(probes).toBe(1);
  expect(state.current?.cancelAttempts).toBe(1);
  expect(state.status).toContain("unresolved");
  now += 570_000;
  await cycle(config, state, persist);
  expect(cancels).toBe(2);
  expect(state.current?.cancelAttempts).toBe(2);
});

test("API cancellation cooldown retains the reservation and does not exhaust the bounded retry budget", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = stopped();
  let cancels = 0;
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route.startsWith("/workers/tasks/task")) return Response.json({ status: "cancelling" });
    if (route === "/api/personal/attempts/attempt")
      return Response.json({ state: "prepared", leaseOwner: "owner", leaseGeneration: 1 });
    if (route === "/api/personal/attempts/attempt/cancel") {
      cancels++;
      return new Response(null, { status: 429, headers: { "retry-after": "600" } });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await expect(cycle(config, state, persist)).rejects.toThrow("HTTP 429");
  state = JSON.parse(JSON.stringify(state));
  now += 30_000;
  await expect(cycle(config, state, persist)).rejects.toThrow("cooldown");
  expect(cancels).toBe(1);
  expect(state.current?.attemptCancelAttempts).toBe(1);
  now += 570_000;
  await expect(cycle(config, state, persist)).rejects.toThrow("HTTP 429");
  expect(cancels).toBe(2);
  expect(state.current?.attemptCancelAttempts).toBe(2);
});
