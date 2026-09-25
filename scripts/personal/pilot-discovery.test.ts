import { createHash } from "node:crypto";
import type { PersonalCampaign } from "../../packages/contracts/src/personal-campaign";
import { LocalHttpError } from "./common";
import { type PilotDiscoveryState, tickPilotDiscovery } from "./pilot-discovery";
import { newPollingState, requestBucket } from "./polling";
import { describe, expect, test } from "bun:test";

const campaignId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
const initial = Date.parse("2026-09-18T12:00:00Z");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function campaign(): PersonalCampaign {
  return {
    id: campaignId,
    status: "active",
    sources: { boardTokens: ["synthetic"] },
    authorization: { runId },
    mode: "submit",
  } as PersonalCampaign;
}
function source(boardToken: string, nextEligibleAt: number | null = null) {
  return {
    id: crypto.randomUUID(),
    identity: `greenhouse:${boardToken}`,
    configuration: { source: "greenhouse", boardToken, employer: "Synthetic employer" },
    configurationState: "valid",
    attemptedAt: null,
    lastSuccessfulAt: null,
    nextEligibleAt: nextEligibleAt === null ? null : new Date(nextEligibleAt).toISOString(),
    updatedAt: new Date(initial).toISOString(),
    status: null,
    coverage: {},
    adapter: {
      discovery: "public_api",
      submission: "guarded_greenhouse",
      readiness: "not_evaluated",
      submissionEnabledByRegistration: false,
    },
  };
}
function page<T>(items: T[], current = 1, total = items.length) {
  return {
    items,
    pagination: { page: current, limit: 100, total, totalPages: Math.ceil(total / 100) },
  };
}
function searchResult(query: string, status = "complete", nextEligibleAt: number | null = null) {
  return {
    provider: "brave",
    status,
    queryHash: hash(query),
    candidates: [],
    coverage: {
      scope: "search_query",
      exhausted: status === "complete",
      empty: true,
      pagesRequested: 1,
      observedCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      moreResultsAvailable: status === "partial",
    },
    receipts: [],
    budget: {
      month: "2026-09",
      timezone: "America/New_York",
      monthlyLimitMicrousd: 200000000,
      searchLimitMicrousd: 50000000,
      monthlyReservedMicrousd: 5000,
      searchReservedMicrousd: 5000,
      tracking: "local_reservations",
      actualProviderBillKnown: false,
    },
    nextEligibleAt: nextEligibleAt === null ? null : new Date(nextEligibleAt).toISOString(),
    reasons: [],
    price: {
      requestMicrousd: 5000,
      verifiedOn: "2026-09-16",
      sourceUrl: "https://brave.com/search/api/",
      creditsAssumed: false,
    },
  };
}
function harness() {
  let now = initial;
  let state: PilotDiscoveryState = {};
  const polling = newPollingState();
  const item = campaign();
  let current: PersonalCampaign[] = [item];
  const calls: { route: string; body: unknown }[] = [];
  const saves: string[] = [];
  let registryRows = [source("synthetic")];
  let registryTotal = 1;
  let failPersist = false;
  let result: Record<string, unknown> = { status: "complete" };
  let searchStatus = "complete";
  let searchNext: number | null = null;
  let candidate = false;
  let throwDiscovery: Error | undefined;
  const api = async (route: string, body?: unknown) => {
    calls.push({ route, body });
    if (route.startsWith("/personal/registry?")) {
      const number = Number(new URL(`http://synthetic${route}`).searchParams.get("page"));
      return {
        sources: registryRows,
        pagination: page(registryRows, number, registryTotal).pagination,
      };
    }
    if (route.startsWith("/personal/campaigns?")) return page(current);
    if (route === "/personal/discover") {
      if (throwDiscovery) throw throwDiscovery;
      return result;
    }
    if (route === "/personal/search") {
      const result = searchResult((body as { query: string }).query, searchStatus, searchNext);
      return {
        ...result,
        candidates: candidate
          ? [
              {
                kind: "career_url_candidate",
                url: "https://unverified.example/careers",
                urlHash: "a".repeat(64),
                title: "Unverified lead",
                snippet: "Search snippet only",
                evidence: "search_snippet",
                fullDescriptionAvailable: false,
                employerIdentityVerified: false,
                page: 0,
                responseHash: "b".repeat(64),
              },
            ]
          : [],
      };
    }
    throw new Error(`Unexpected synthetic API route ${route}`);
  };
  const tick = (queries: { campaignId: string; query: string; maxPages?: number }[] = []) =>
    tickPilotDiscovery(
      state,
      polling,
      [item],
      { queries },
      {
        api,
        now: () => now,
        persist: async () => {
          if (failPersist) throw new Error("synthetic persistence failure");
          saves.push(JSON.stringify({ state, polling }));
        },
      },
    );
  return {
    item,
    polling,
    calls,
    saves,
    tick,
    state: () => state,
    advance: (ms = 60_000) => {
      now += ms;
    },
    now: () => now,
    restart: () => {
      state = JSON.parse(JSON.stringify(state));
    },
    registry: (rows: ReturnType<typeof source>[], total = rows.length) => {
      registryRows = rows;
      registryTotal = total;
    },
    current: (rows: PersonalCampaign[]) => {
      current = rows;
    },
    result: (value: Record<string, unknown>) => {
      result = value;
    },
    search: (status: string, next: number | null = null) => {
      searchStatus = status;
      searchNext = next;
    },
    candidate: () => {
      candidate = true;
    },
    rejectDiscovery: (error: Error) => {
      throwDiscovery = error;
    },
    failPersist: () => {
      failPersist = true;
    },
  };
}
const posts = (h: ReturnType<typeof harness>) => h.calls.filter((call) => call.body !== undefined);

describe("durable configured discovery scheduler", () => {
  test("stopped or unauthorized campaigns make no registry, source or search calls", async () => {
    for (const stopped of [true, false]) {
      const h = harness();
      if (stopped) h.item.status = "stopped";
      else h.item.authorization = null;
      await h.tick([{ campaignId, query: "explicit synthetic careers" }]);
      expect(h.calls).toEqual([]);
    }
  });
  test("deduplicates campaign sources, skips CBS and refreshes manually configured unregistered sources", async () => {
    const h = harness();
    h.registry([]);
    h.item.sources.instances = [
      { source: "greenhouse", boardToken: "synthetic" },
      { source: "lever", boardToken: "synthetic", region: "eu" },
      { source: "cbs", boardToken: "career" },
    ];
    await h.tick();
    await h.tick();
    h.restart();
    h.advance();
    await h.tick();
    expect(posts(h).map((call) => call.body)).toEqual([
      { source: "greenhouse", boardToken: "synthetic", campaignId, runId },
      { source: "lever", boardToken: "synthetic", region: "eu", campaignId, runId },
    ]);
    expect(Object.keys(h.polling.discoveries)).toHaveLength(2);
    expect(h.saves.length).toBeGreaterThanOrEqual(4);
  });
  test("observes registry cooldowns and preserves a bounded registry page cursor across restart", async () => {
    const h = harness();
    h.registry([source("synthetic", initial + 600_000)], 101);
    await h.tick();
    expect(posts(h)).toEqual([]);
    h.restart();
    h.advance();
    h.registry([source("unscoped")], 101);
    await h.tick();
    expect(
      h.calls
        .filter((call) => call.route.startsWith("/personal/registry"))
        .map((call) => call.route),
    ).toEqual(["/personal/registry?page=1&limit=100", "/personal/registry?page=2&limit=100"]);
    expect(posts(h)).toEqual([]);
    h.advance(600_000);
    await h.tick();
    expect(posts(h)).toHaveLength(1);
    expect(posts(h)[0]?.body).toMatchObject({ boardToken: "synthetic" });
  });
  test("shares legacy polling fences and never guesses or auto-registers registry-only boards", async () => {
    const h = harness();
    h.registry([source("unscoped")]);
    h.polling.discoveries["greenhouse:synthetic"] = {
      nextAttemptAt: initial + 3_600_000,
      failures: 0,
    };
    await h.tick();
    expect(posts(h)).toEqual([]);
    h.advance(3_600_000);
    await h.tick();
    expect(posts(h).map((call) => call.body)).toEqual([
      { source: "greenhouse", boardToken: "synthetic", campaignId, runId },
    ]);
  });
  test("fresh stopped, replaced run, or changed source membership blocks dispatch", async () => {
    for (const mode of ["stopped", "run", "source"] as const) {
      const h = harness();
      const current = structuredClone(h.item);
      if (mode === "stopped") current.status = "stopped";
      if (mode === "run") current.authorization!.runId = crypto.randomUUID();
      if (mode === "source") current.sources.boardTokens = ["different"];
      h.current([current]);
      await h.tick();
      expect(posts(h)).toEqual([]);
    }
  });
  test("persists the request fence before a source POST and retains failed attempts without success", async () => {
    const h = harness();
    h.result({ status: "partial", nextEligibleAt: new Date(initial + 600_000).toISOString() });
    await h.tick();
    const record = h.polling.discoveries["greenhouse:synthetic"]!;
    expect(record.outcome).toBe("partial");
    expect(record.succeededAt).toBeUndefined();
    expect(record.nextAttemptAt).toBe(initial + 600_000);
    expect(h.saves.some((value) => value.includes('"attemptedAt"'))).toBe(true);
    const failed = harness();
    failed.failPersist();
    await expect(failed.tick()).rejects.toThrow("persistence");
    expect(posts(failed)).toEqual([]);
  });
  test("keeps source Retry-After separate from other sources and global HTTP cooldown", async () => {
    const h = harness();
    h.rejectDiscovery(
      new LocalHttpError(429, "api", "/personal/discover", "POST", "600", "source"),
    );
    await h.tick();
    expect(h.polling.discoveries["greenhouse:synthetic"]?.outcome).toBe("failed");
    expect(h.polling.discoveries["greenhouse:synthetic"]?.succeededAt).toBeUndefined();
    const held = harness();
    held.polling.cooldowns[requestBucket("api", "POST", "/personal/discover")] = initial + 600_000;
    await held.tick();
    expect(posts(held)).toEqual([]);
  });
  test("rotates only explicit campaign-bound queries and persists partial coverage without verification", async () => {
    const h = harness();
    h.item.sources.boardTokens = [];
    h.registry([]);
    h.search("partial");
    h.candidate();
    const queries = [
      { campaignId, query: "Alpha careers", maxPages: 2 },
      { campaignId, query: "Beta careers" },
      { campaignId: crypto.randomUUID(), query: "Stopped careers" },
    ];
    await h.tick(queries);
    h.restart();
    h.advance();
    await h.tick(queries);
    h.advance();
    await h.tick(queries);
    expect(posts(h)).toHaveLength(2);
    expect(posts(h).every((call) => call.route === "/personal/search")).toBe(true);
    for (const call of posts(h)) expect(call.body).toMatchObject({ campaignId, runId });
    expect(new Set(posts(h).map((call) => (call.body as { query: string }).query))).toEqual(
      new Set(["Alpha careers", "Beta careers"]),
    );
    expect(JSON.stringify(h.state())).toContain("local_reservations");
    expect(JSON.stringify(h.state())).toContain('"actualProviderBillKnown":false');
    expect(JSON.stringify(h.state())).not.toContain('employerIdentityVerified":true');
    expect(JSON.stringify(h.state())).not.toContain("Alpha careers");
    expect(JSON.stringify(h.state())).not.toContain("unverified.example");
  });
  test("alternates sources and searches within one shared minute fence and stops all calls after stop", async () => {
    const h = harness();
    h.item.sources.instances = [{ source: "ashby", boardToken: "other" }];
    const queries = [{ campaignId, query: "Explicit synthetic careers" }];
    for (let i = 0; i < 12; i++) {
      await h.tick(queries);
      h.advance(15_000);
    }
    expect(posts(h).map((call) => call.route)).toEqual([
      "/personal/discover",
      "/personal/search",
      "/personal/discover",
    ]);
    const count = h.calls.length;
    h.item.status = "stopped";
    h.advance(86_400_000);
    await h.tick(queries);
    expect(h.calls).toHaveLength(count);
  });
  test.each([
    "budget_exhausted",
    "cooldown",
    "missing_setup",
  ])("holds all query dispatch after %s, including restart", async (status) => {
    const h = harness();
    h.item.sources.boardTokens = [];
    h.registry([]);
    h.search(status, status === "missing_setup" ? null : initial + 3_600_000);
    const queries = [
      { campaignId, query: "Alpha careers" },
      { campaignId, query: "Beta careers" },
    ];
    await h.tick(queries);
    h.restart();
    h.advance(600_000);
    await h.tick(queries);
    expect(posts(h)).toHaveLength(1);
  });
  test("rejects malformed query configuration without issuing any request", async () => {
    const h = harness();
    await expect(h.tick([{ campaignId, query: "synthetic", maxPages: 99 }])).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
});
