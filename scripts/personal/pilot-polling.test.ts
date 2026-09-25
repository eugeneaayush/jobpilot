import type { PersonalCampaign } from "../../packages/contracts/src/personal-campaign";
import { LocalHttpError, type RuntimeConfig } from "./common";
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
type State = Parameters<typeof cycle>[1];
const fresh = (): State => ({
  owner: "synthetic-owner",
  discoveries: {},
  updatedAt: "",
  status: "starting",
  digest: { nextCheckAt: Number.MAX_SAFE_INTEGER },
});
const campaign = (board = "fixture"): PersonalCampaign => {
  const suffix = createHash("sha256").update(board).digest("hex").slice(0, 12);
  return {
    id: `10000000-0000-4000-8000-${suffix}`,
    name: `Synthetic ${board}`,
    status: "active",
    authorization: {
      runId: `20000000-0000-4000-8000-${suffix}`,
      authorizedAt: new Date(0).toISOString(),
      settingsHash: "a".repeat(64),
      resumeEvidenceId: "30000000-0000-4000-8000-000000000001",
      sourceHash: "b".repeat(64),
      snapshotHash: "c".repeat(64),
    },
    sources: { boardTokens: [board] },
    mode: "offline",
    dailyCap: 100,
    maxApplications: 1000,
    timezone: "America/New_York",
    policyVersion: "1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    tracks: ["mba_internship"],
    fitThreshold: 90,
  };
};
const page = (items: unknown[], total = items.length) => ({
  items,
  pagination: { total, totalPages: Math.ceil(total / 100), page: 1, limit: 100 },
});
const emptyRegistry = () => ({ sources: [], pagination: page([]).pagination });
const run = (state: State, persist: (state: State) => Promise<void> = async () => {}) =>
  cycle(config, state, persist);

test("four hours of twenty idle campaigns stay within finite polling capacity and share work fairly", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const campaigns = Array.from({ length: 20 }, (_, i) => campaign(`board-${i}`));
  const state = fresh();
  let listReads = 0;
  let scheduledListReads = 0;
  let authorizationReads = 0;
  const listReadTimes: number[] = [];
  let preparations = 0;
  const nexts = new Map<string, number>();
  const discoveries = new Map<string, number>();
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/personal/campaigns") {
      listReads++;
      listReadTimes.push(now);
      if (now >= (state.polling?.list?.nextAt ?? 0)) scheduledListReads++;
      else authorizationReads++;
      return Response.json(page(campaigns));
    }
    if (url.pathname === "/api/personal/registry") return Response.json(emptyRegistry());
    if (url.pathname === "/api/personal") {
      preparations++;
      return Response.json({ records: page([]) });
    }
    if (url.pathname === "/api/personal/discover") {
      const body = JSON.parse(String(init?.body));
      discoveries.set(body.boardToken, (discoveries.get(body.boardToken) ?? 0) + 1);
      return Response.json({ status: "complete" });
    }
    const id = /^\/api\/personal\/campaigns\/([^/]+)\/next$/.exec(url.pathname)?.[1];
    if (id) {
      nexts.set(id, (nexts.get(id) ?? 0) + 1);
      return Response.json({ status: "idle", reasons: ["no records"] });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  }) as typeof fetch;
  for (let tick = 0; tick < 4 * 60 * 4; tick++) {
    await run(state);
    now += 15_000;
  }
  expect(scheduledListReads).toBeLessThan(60);
  expect(authorizationReads).toBeLessThanOrEqual(80);
  expect(listReads).toBe(scheduledListReads + authorizationReads);
  expect(listReads).toBeLessThan(140);
  for (const start of listReadTimes)
    expect(
      listReadTimes.filter((time) => time >= start && time < start + 3_600_000).length,
    ).toBeLessThan(60);
  expect([...nexts.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(960);
  expect(Math.min(...nexts.values())).toBeGreaterThan(40);
  expect(Math.max(...nexts.values()) - Math.min(...nexts.values())).toBeLessThanOrEqual(1);
  expect(preparations).toBeLessThanOrEqual(240);
  expect(Object.keys(state.polling!.preparations)).toHaveLength(20);
  expect(discoveries.size).toBe(20);
  expect(Math.max(...discoveries.values())).toBeLessThanOrEqual(4);
  expect(state.current).toBeUndefined();
});

test("a persisted list Retry-After survives restart without repeated requests", async () => {
  let now = Date.parse("2026-09-16T12:00:00Z");
  Date.now = () => now;
  let state = fresh();
  let calls = 0;
  let persisted = "";
  globalThis.fetch = (async (_input: string | URL | Request) => {
    calls++;
    if (calls === 1)
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "Wed, 16 Sep 2026 12:02:00 GMT" },
      });
    return Response.json(page([]));
  }) as typeof fetch;
  await expect(
    run(state, async (value) => {
      persisted = JSON.stringify(value);
    }),
  ).rejects.toBeInstanceOf(LocalHttpError);
  state = JSON.parse(persisted);
  now += 119_999;
  await expect(run(state)).rejects.toThrow("cooldown");
  expect(calls).toBe(1);
  now++;
  await run(state);
  expect(calls).toBe(2);
  expect(state.status).toContain("Idle");
});

test("an active lease renews independently of campaign reads and their cooldown", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  const state = fresh();
  state.polling = newPollingState();
  state.polling.cooldowns[requestBucket("api", "GET", "/personal/campaigns")] = now + 3_600_000;
  state.campaignCache = [];
  state.current = {
    phase: "worker",
    startedAt: now,
    request: { taskId: "task", role: "worker", adapter: "mock", kind: "apply", input: {} },
    leased: {
      status: "task",
      campaignId: "fixture",
      mode: "offline",
      attempt: {
        id: "attempt",
        leaseOwner: "owner",
        leaseGeneration: 1,
        state: "prepared",
        manifestHash: "hash",
      },
      record: {
        id: "record",
        identity: "greenhouse:fixture:record",
        title: "Synthetic",
        company: "Fixture",
        url: "https://example.test/job",
        track: "mba_internship",
      },
      task: { kind: "apply", attemptId: "attempt", brokerPath: "/synthetic" },
    },
  };
  const routes: string[] = [];
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    routes.push(route);
    if (route === "/api/personal/attempts/attempt")
      return Response.json({
        state: "prepared",
        leaseOwner: "owner",
        leaseGeneration: 1,
        leaseExpiresAt: new Date(now + 90_000).toISOString(),
        manifestHash: "hash",
      });
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/task") return Response.json({ status: "running" });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await run(state);
  expect(routes).toEqual([
    "/api/personal/attempts/attempt",
    "/api/personal/attempts/attempt/checkpoint",
    "/workers/tasks/task",
  ]);
  expect(state.current?.request.taskId).toBe("task");
});

test("source instances deduplicate legacy Greenhouse, preserve Lever regions, and skip automatic CBS", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const item = campaign();
  item.sources.instances = [
    { source: "greenhouse", boardToken: "fixture" },
    { source: "lever", boardToken: "tenant", region: "eu" },
    { source: "lever", boardToken: "tenant" },
    { source: "ashby", boardToken: "tenant" },
    { source: "cbs", boardToken: "career" },
  ];
  const state = fresh();
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/campaigns") return Response.json(page([item]));
    if (route === "/api/personal/registry") return Response.json(emptyRegistry());
    if (route === "/api/personal") return Response.json({ records: page([]) });
    if (route === "/api/personal/discover") {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "complete" });
    }
    return Response.json({ status: "idle", reasons: [] });
  }) as typeof fetch;
  for (let tick = 0; tick < 80; tick++) {
    await run(state);
    now += 15_000;
  }
  expect(bodies).toEqual([
    {
      source: "ashby",
      boardToken: "tenant",
      campaignId: item.id,
      runId: item.authorization!.runId,
    },
    {
      source: "greenhouse",
      boardToken: "fixture",
      campaignId: item.id,
      runId: item.authorization!.runId,
    },
    {
      source: "lever",
      boardToken: "tenant",
      region: "eu",
      campaignId: item.id,
      runId: item.authorization!.runId,
    },
    {
      source: "lever",
      boardToken: "tenant",
      region: "global",
      campaignId: item.id,
      runId: item.authorization!.runId,
    },
  ]);
  expect(Object.keys(state.polling!.discoveries).sort()).toEqual([
    "ashby:tenant",
    "greenhouse:fixture",
    "lever:eu:tenant",
    "lever:global:tenant",
  ]);
});

test("discovery 429 persists attempted time and server cooldown without claiming a successful refresh", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  const state = fresh();
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    paths.push(route);
    if (route === "/api/personal/campaigns") return Response.json(page([campaign()]));
    if (route === "/api/personal/registry") return Response.json(emptyRegistry());
    if (route === "/api/personal/discover")
      return new Response(null, { status: 429, headers: { "retry-after": "600" } });
    if (route.endsWith("/next")) return Response.json({ status: "idle", reasons: [] });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await run(state);
  expect(state.polling!.discoveries["greenhouse:fixture"]).toEqual({
    attemptedAt: now,
    nextAttemptAt: now + 600_000,
    failures: 1,
    outcome: "failed",
  });
  expect(paths).not.toContain("/api/personal");
  expect(state.polling!.cooldowns[requestBucket("api", "POST", "/personal/discover")]).toBe(
    now + 600_000,
  );
});

test("local digest remains scheduled while every campaign is stopped", async () => {
  const state = fresh();
  state.digest = {};
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    calls.push(route);
    if (route === "/api/personal/digest/tick") return Response.json({ status: "created" });
    if (route === "/api/personal/campaigns") return Response.json(page([]));
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await run(state);
  expect(state.digest.lastStatus).toBe("created");
  expect(state.status).toContain("Idle");
  await run(state);
  expect(calls.filter((value) => value.endsWith("/digest/tick"))).toHaveLength(1);
});

test("preparation orders by fit without excluding low fit, holds absent or undergraduate evidence, and scopes imported sources", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const item = campaign();
  item.sources = {
    boardTokens: [],
    instances: [
      { source: "cbs", boardToken: "career" },
      { source: "lever", boardToken: "tenant", region: "eu" },
    ],
  };
  const state = fresh();
  const row = (
    id: string,
    fitScore: number,
    classification: string | null = "graduate_recruiting",
    identity = `cbs:career:${id}`,
  ) => ({
    id,
    identity,
    track: "mba_internship",
    fitScore,
    state: "discovered",
    preview: null,
    updatedAt: new Date(1_000_000).toISOString(),
    eligibility: { decision: "eligible" },
    ...(classification && { seniority: { classification } }),
  });
  const prepared: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/campaigns") return Response.json(page([item]));
    if (route === "/api/personal/registry") return Response.json(emptyRegistry());
    if (route === "/api/personal")
      return Response.json({
        records: page([
          row("low", 10),
          row("unresolved", 100, "unresolved"),
          row("undergraduate", 100, "undergraduate_entry"),
          row("missing", 100, null),
          row("wrong-region", 99, "graduate_recruiting", "lever:global:tenant:1"),
          row("higher", 40, "experienced_professional", "lever:eu:tenant:1"),
        ]),
      });
    if (route.endsWith("/preparation")) {
      expect(JSON.parse(String(init?.body))).toEqual({ campaignId: item.id });
      prepared.push(route);
      return Response.json({
        status: "ready",
        phase: "complete",
        reason: null,
        recordUpdatedAt: new Date(1_000_000).toISOString(),
      });
    }
    if (route.endsWith("/discover")) return Response.json({ status: "complete" });
    return Response.json({ status: "idle", reasons: [] });
  }) as typeof fetch;
  await run(state);
  expect(prepared).toEqual(["/api/personal/higher/preparation"]);
  now += 60_000;
  await run(state);
  expect(prepared).toEqual(["/api/personal/higher/preparation", "/api/personal/low/preparation"]);
});

import { createHash } from "node:crypto";

test("ready first records cannot starve later preparation, and cache holds bind record version and campaign run", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const item = campaign();
  item.sources = { boardTokens: [], instances: [{ source: "cbs", boardToken: "career" }] };
  const state = fresh();
  const rows = [
    { id: "ready", fitScore: 100, state: "prepared" },
    { id: "waiting", fitScore: 10, state: "eligible" },
  ].map((value) => ({
    ...value,
    identity: `cbs:career:${value.id}`,
    track: "mba_internship",
    eligibility: { decision: "eligible" },
    seniority: { classification: "graduate_recruiting" },
    updatedAt: new Date(1_000_000).toISOString(),
    preview: null,
  }));
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/campaigns") return Response.json(page([item]));
    if (route === "/api/personal/registry") return Response.json(emptyRegistry());
    if (route === "/api/personal") return Response.json({ records: page(rows) });
    if (route.endsWith("/preparation")) {
      expect(JSON.parse(String(init?.body))).toEqual({ campaignId: item.id });
      const id = route.split("/").at(-2)!;
      const row = rows.find((value) => value.id === id)!;
      calls.push(id);
      return Response.json({
        status: id === "ready" ? "ready" : "advanced",
        phase: id === "ready" ? "complete" : "preview",
        reason: null,
        nextEligibleAt: new Date(now + 3_600_000).toISOString(),
        recordUpdatedAt: row.updatedAt,
      });
    }
    if (route.endsWith("/next")) return Response.json({ status: "idle", reasons: [] });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await run(state);
  expect(calls).toEqual(["ready"]);
  now += 60_000;
  await run(state);
  expect(calls).toEqual(["ready", "waiting"]);
  now += 60_000;
  await run(state);
  expect(calls).toEqual(["ready", "waiting"]);
  rows[0]!.updatedAt = new Date(now).toISOString();
  now += 60_000;
  await run(state);
  expect(calls).toEqual(["ready", "waiting", "ready"]);
  item.authorization!.runId = "20000000-0000-4000-8000-999999999999";
  now += 300_000;
  await run(state);
  expect(calls).toEqual(["ready", "waiting", "ready", "ready"]);
  expect(state.preparationHolds?.ready?.runId).toBe(item.authorization!.runId);
});
