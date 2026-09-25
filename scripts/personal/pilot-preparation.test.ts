import type { PersonalCampaign } from "../../packages/contracts/src/personal-campaign";
import type { RuntimeConfig } from "./common";
import { cycle } from "./pilot";
import { newPollingState, requestBucket } from "./polling";
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
const campaign: PersonalCampaign = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Synthetic preparation cadence",
  mode: "submit",
  sources: { boardTokens: [], instances: [{ source: "cbs", boardToken: "fixture" }] },
  tracks: ["mba_internship"],
  dailyCap: 50,
  fitThreshold: 0,
  maxApplications: 1000,
  timezone: "America/New_York",
  status: "active",
  policyVersion: "synthetic",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  authorization: {
    runId: "20000000-0000-4000-8000-000000000001",
    authorizedAt: new Date(0).toISOString(),
    settingsHash: "a".repeat(64),
    resumeEvidenceId: "30000000-0000-4000-8000-000000000001",
    sourceHash: "b".repeat(64),
    snapshotHash: "c".repeat(64),
  },
};
type State = Parameters<typeof cycle>[1];
const fresh = (now: number): State => {
  const polling = newPollingState();
  polling.list = { idleCount: 6, nextAt: now + 3_600_000 };
  polling.campaigns[campaign.id] = { idleCount: 6, nextAt: now + 300_000 };
  polling.scheduleNextAt = now + 300_000;
  return {
    owner: "synthetic-owner",
    discoveries: {},
    polling,
    campaignCache: [structuredClone(campaign)],
    digest: { nextCheckAt: Number.MAX_SAFE_INTEGER },
    status: "waiting",
    updatedAt: "",
  };
};
const row = (id: string, now: number) => ({
  id,
  identity: `cbs:fixture:${id}`,
  track: "mba_internship",
  fitScore: 70,
  state: "eligible",
  eligibility: { decision: "eligible" },
  seniority: { classification: "graduate_recruiting" },
  updatedAt: new Date(now).toISOString(),
});
const page = (items: unknown[], total = 778) => ({
  records: { items, pagination: { total, totalPages: Math.ceil(total / 100), limit: 100 } },
});
const run = (state: State) => cycle(config, state, async () => {});

test("four phases finish at minute cadence across eight pages despite five-minute application idle backoff", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = fresh(now);
  let current = row("first", now);
  const pages: number[] = [];
  const preparations: { id: string; at: number }[] = [];
  let directReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/personal") {
      const number = Number(url.searchParams.get("page"));
      pages.push(number);
      return Response.json(page([number === 1 ? current : row("second", now)]));
    }
    if (url.pathname === "/api/personal/first") {
      directReads++;
      return Response.json(current);
    }
    if (url.pathname.endsWith("/preparation")) {
      expect(JSON.parse(String(init?.body))).toEqual({ campaignId: campaign.id });
      const id = url.pathname.split("/").at(-2)!;
      preparations.push({ id, at: now });
      current = row("first", now);
      const phase = ["claim_review", "preview", "render_review", "complete"][
        preparations.length - 1
      ];
      const status = id === "second" ? "blocked" : phase === "complete" ? "ready" : "pending";
      return Response.json({
        status,
        phase: phase ?? "propose",
        reason: status === "blocked" ? "Synthetic missing input" : null,
        recordUpdatedAt: current.updatedAt,
        nextEligibleAt:
          status === "ready"
            ? null
            : new Date(now + (status === "blocked" ? 3_600_000 : 15_000)).toISOString(),
      });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  }) as typeof fetch;
  for (let phase = 0; phase < 4; phase++) {
    await run(state);
    expect(preparations).toHaveLength(phase + 1);
    state = JSON.parse(JSON.stringify(state));
    now += 45_000;
    await run(state);
    expect(preparations).toHaveLength(phase + 1);
    now += 15_000;
  }
  expect(preparations.map((value) => value.at)).toEqual([
    1_000_000, 1_060_000, 1_120_000, 1_180_000,
  ]);
  expect(preparations.every((value) => value.id === "first")).toBe(true);
  expect(pages).toEqual([1]);
  expect(directReads).toBe(3);
  expect(state.preparationContinuations?.[campaign.id]).toBeUndefined();
  expect(state.preparationHolds?.first?.nextAt).toBe(Number.MAX_SAFE_INTEGER);
  await run(state);
  expect(pages).toEqual([1, 2]);
  expect(preparations.at(-1)?.id).toBe("second");
  expect(state.preparationContinuations?.[campaign.id]).toBeUndefined();
  expect(state.preparationHolds?.second?.nextAt).toBe(now + 3_600_000);
});

test("a held phase yields the page cursor and retains the server retry bound", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const state = fresh(now);
  const calls: string[] = [];
  const pages: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/personal") {
      const number = Number(url.searchParams.get("page"));
      pages.push(number);
      return Response.json(page([row(number === 1 ? "held" : "other", now)]));
    }
    if (url.pathname.endsWith("/preparation")) {
      calls.push(url.pathname);
      return Response.json({
        status: "blocked",
        phase: "propose",
        reason: "Synthetic hold",
        nextEligibleAt: new Date(now + 3_600_000).toISOString(),
        recordUpdatedAt: new Date(now).toISOString(),
      });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  }) as typeof fetch;
  await run(state);
  const retryAt = state.preparationHolds!.held!.nextAt;
  now += 60_000;
  await run(state);
  expect(pages).toEqual([1, 2]);
  expect(calls).toEqual(["/api/personal/held/preparation", "/api/personal/other/preparation"]);
  expect(state.preparationHolds!.held!.nextAt).toBe(retryAt);
  expect(state.preparationContinuations?.[campaign.id]).toBeUndefined();
});

test("repeated pending phases yield after four advances and reauthorized campaigns discard old continuations", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const state = fresh(now);
  const pages: number[] = [];
  let calls = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/personal") {
      pages.push(Number(url.searchParams.get("page")));
      return Response.json(page([row("changing", now)]));
    }
    if (url.pathname === "/api/personal/changing") return Response.json(row("changing", now));
    if (url.pathname.endsWith("/preparation")) {
      calls++;
      return Response.json({
        status: "pending",
        phase: "propose",
        reason: null,
        nextEligibleAt: new Date(now + 15_000).toISOString(),
        recordUpdatedAt: new Date(now).toISOString(),
      });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  }) as typeof fetch;
  for (let count = 0; count < 4; count++) {
    await run(state);
    now += 60_000;
  }
  expect(calls).toBe(4);
  expect(pages).toEqual([1]);
  expect(state.preparationContinuations?.[campaign.id]).toBeUndefined();
  state.preparationContinuations = {
    [campaign.id]: { recordId: "old", runId: "previous-run", advances: 1 },
  };
  await run(state);
  expect(pages).toEqual([1, 2]);
  expect(calls).toBe(5);
});

test("preparation Retry-After blocks the phase without creating a busy retry loop", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  const state = fresh(now);
  state.polling!.cooldowns[requestBucket("api", "POST", "/personal/record/preparation")] =
    now + 600_000;
  globalThis.fetch = (async () => {
    throw new Error("No synthetic request is due");
  }) as unknown as typeof fetch;
  await run(state);
  expect(state.polling!.preparations).toEqual({});
});

test("ready preparation wakes only its campaign while respecting the global scheduler fence", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const state = fresh(now);
  state.polling!.scheduleNextAt = now + 15_000;
  state.polling!.campaigns.other = { idleCount: 6, nextAt: now + 300_000 };
  const other = structuredClone(state.polling!.campaigns.other);
  let nextCalls = 0;
  let preparationCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/personal") return Response.json(page([row("finishing", now)]));
    if (url.pathname === "/api/personal/registry")
      return Response.json({
        sources: [],
        pagination: { total: 0, totalPages: 0, page: 1, limit: 100 },
      });
    if (url.pathname.endsWith("/preparation")) {
      preparationCalls++;
      return Response.json({
        status: "ready",
        phase: "complete",
        reason: null,
        nextEligibleAt: null,
        recordUpdatedAt: new Date(now).toISOString(),
      });
    }
    if (url.pathname.endsWith("/next")) {
      nextCalls++;
      return Response.json({ status: "idle", reasons: [] });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  }) as typeof fetch;
  await run(state);
  expect(state.polling!.campaigns[campaign.id]).toEqual({ idleCount: 0, nextAt: now });
  expect(state.polling!.campaigns.other).toEqual(other);
  expect(state.polling!.scheduleNextAt).toBe(now + 15_000);
  now += 14_999;
  await run(state);
  expect(nextCalls).toBe(0);
  now++;
  await run(state);
  expect(nextCalls).toBe(1);
  expect(preparationCalls).toBe(1);
});
