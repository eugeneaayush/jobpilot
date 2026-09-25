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
  name: "Synthetic isolation",
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
function fixture(now: number): State {
  const polling = newPollingState();
  polling.list = { idleCount: 6, nextAt: now + 3_600_000 };
  polling.campaigns[campaign.id] = { idleCount: 6, nextAt: now + 300_000 };
  polling.scheduleNextAt = now + 300_000;
  return {
    owner: "synthetic",
    discoveries: {},
    polling,
    campaignCache: [campaign],
    digest: { nextCheckAt: Number.MAX_SAFE_INTEGER },
    status: "waiting",
    updatedAt: "",
  };
}
const row = (id: string, fitScore: number) => ({
  id,
  fitScore,
  identity: `cbs:fixture:${id}`,
  track: "mba_internship",
  state: "eligible",
  eligibility: { decision: "eligible" },
  seniority: { classification: "graduate_recruiting" },
  updatedAt: new Date(0).toISOString(),
});

for (const status of [404, 409]) {
  test(`row HTTP ${status} yields to another same-page candidate at the next minute without request bursts`, async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let state = fixture(now);
    const phases: string[] = [];
    const reads: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      reads.push(url.pathname);
      if (url.pathname === "/api/personal")
        return Response.json({
          records: { items: [row("conflict", 90), row("other", 80)], pagination: { total: 778 } },
        });
      if (url.pathname === "/api/personal/other") return Response.json(row("other", 80));
      if (url.pathname.endsWith("/preparation")) {
        phases.push(url.pathname);
        if (url.pathname.includes("/conflict/")) return new Response(null, { status });
        return Response.json({
          status: "ready",
          phase: "complete",
          reason: null,
          recordUpdatedAt: new Date(0).toISOString(),
          nextEligibleAt: null,
        });
      }
      throw new Error(`Unexpected synthetic request ${url.pathname}`);
    }) as typeof fetch;
    await cycle(config, state, async () => {});
    expect(phases).toEqual(["/api/personal/conflict/preparation"]);
    expect(state.preparationHolds?.conflict?.nextAt).toBe(
      now + (status === 409 ? 60_000 : 3_600_000),
    );
    expect(state.preparationContinuations?.[campaign.id]?.recordId).toBe("other");
    expect(state.polling!.preparations[campaign.id]?.page).toBe(2);
    state = JSON.parse(JSON.stringify(state));
    now += 59_999;
    await cycle(config, state, async () => {});
    expect(phases).toHaveLength(1);
    now++;
    await cycle(config, state, async () => {});
    expect(phases).toEqual([
      "/api/personal/conflict/preparation",
      "/api/personal/other/preparation",
    ]);
    expect(reads).toContain("/api/personal/other");
    expect(reads.filter((route) => route === "/api/personal")).toHaveLength(1);
    expect(state.preparationContinuations?.[campaign.id]).toBeUndefined();
  });
}

for (const status of [401, 403, 429, 503, 409]) {
  test(`global HTTP ${status} is not converted into a per-row hold`, async () => {
    const now = 1_000_000;
    Date.now = () => now;
    const state = fixture(now);
    let posts = 0;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/personal")
        return Response.json({
          records: { items: [row("first", 90), row("other", 80)], pagination: { total: 2 } },
        });
      if (url.pathname.endsWith("/preparation")) {
        posts++;
        return new Response(null, {
          status,
          ...(status >= 409 && { headers: { "retry-after": "600" } }),
        });
      }
      throw new Error(`Unexpected synthetic request ${url.pathname}`);
    }) as typeof fetch;
    await expect(cycle(config, state, async () => {})).rejects.toThrow(`HTTP ${status}`);
    expect(posts).toBe(1);
    expect(state.preparationHolds).toEqual({});
    expect(state.preparationContinuations).toEqual({});
    if (status >= 409)
      expect(
        state.polling!.cooldowns[requestBucket("api", "POST", "/personal/record/preparation")],
      ).toBe(now + 600_000);
  });
}

test("one preparation conflict cannot prevent the already-due application scheduler", async () => {
  const now = 1_000_000;
  Date.now = () => now;
  const state = fixture(now);
  state.polling!.scheduleNextAt = 0;
  state.polling!.campaigns[campaign.id] = { idleCount: 0, nextAt: 0 };
  let scheduled = 0;
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/registry")
      return Response.json({ sources: [], pagination: { total: 0, totalPages: 0 } });
    if (route === "/api/personal")
      return Response.json({ records: { items: [row("conflict", 90)], pagination: { total: 1 } } });
    if (route.endsWith("/preparation")) return new Response(null, { status: 409 });
    if (route.endsWith("/next")) {
      scheduled++;
      return Response.json({ status: "idle", reasons: [] });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await cycle(config, state, async () => {});
  expect(scheduled).toBe(1);
  expect(state.preparationHolds?.conflict?.nextAt).toBe(now + 60_000);
  expect(state.polling!.preparationNextAt).toBe(now + 60_000);
});

test("user-slot contention persists a global 60-second cooldown without holding individual records", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = fixture(now);
  let phases = 0;
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal")
      return Response.json({
        records: { items: [row("first", 90), row("other", 80)], pagination: { total: 2 } },
      });
    if (route.endsWith("/preparation")) {
      phases++;
      return Response.json(
        { detail: "One preparation worker already owns this user slot" },
        { status: 409, headers: { "retry-after": "60" } },
      );
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await expect(cycle(config, state, async () => {})).rejects.toThrow("HTTP 409");
  expect(state.preparationHolds).toEqual({});
  expect(state.preparationContinuations).toEqual({});
  state = JSON.parse(JSON.stringify(state));
  now += 59_999;
  await cycle(config, state, async () => {});
  expect(phases).toBe(1);
  now++;
  await expect(cycle(config, state, async () => {})).rejects.toThrow("HTTP 409");
  expect(phases).toBe(2);
  expect(state.preparationHolds).toEqual({});
});
