import type { PersonalCampaign } from "../../packages/contracts/src/personal-campaign";
import type { RuntimeConfig } from "./common";
import type { EmailExecution } from "./email";
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
const campaign: PersonalCampaign = {
  id: "campaign",
  name: "Synthetic official email",
  mode: "submit",
  sources: { boardTokens: [], instances: [{ source: "cbs", boardToken: "fixture" }] },
  tracks: ["mba_internship"],
  dailyCap: 1,
  fitThreshold: 0,
  maxApplications: 1,
  timezone: "America/New_York",
  status: "active",
  policyVersion: "synthetic",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  authorization: null,
};
const leased: EmailExecution["leased"] = {
  status: "task",
  campaignId: campaign.id,
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
    identity: "cbs:fixture:role",
    title: "Synthetic MBA role",
    company: "Fixture",
    url: "https://example.test/job",
    track: "mba_internship",
  },
  task: {
    kind: "apply",
    attemptId: "attempt",
    brokerPath: "/synthetic-unused",
    applicationMethod: "official_email",
  },
};
const fresh = (): State => {
  const polling = newPollingState();
  polling.preparationNextAt = Number.MAX_SAFE_INTEGER;
  return {
    owner: "owner",
    discoveries: {},
    polling,
    digest: { nextCheckAt: Number.MAX_SAFE_INTEGER },
    status: "starting",
    updatedAt: "",
  };
};
const observed = (state: string, leaseGeneration = 1) => ({
  state,
  leaseOwner: "owner",
  leaseGeneration,
  leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
});

test("email-only submit campaign reaches frozen dispatch with unavailable browser and no model approval", async () => {
  const state = fresh();
  let saved = "";
  let attempt = observed("prepared");
  let browserCalls = 0;
  let dispatches = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.port === "4102") {
      browserCalls++;
      throw new Error("Synthetic browser unavailable");
    }
    if (url.pathname === "/api/personal/campaigns")
      return Response.json({ items: [campaign], pagination: { total: 1 } });
    if (url.pathname.endsWith("/next")) return Response.json(leased);
    if (url.pathname === "/api/personal/attempts/attempt") return Response.json(attempt);
    if (url.pathname.endsWith("/dispatch")) {
      dispatches++;
      expect(JSON.parse(saved).emailCurrent.dispatchRequested).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ leaseOwner: "owner", leaseGeneration: 1 });
      attempt = observed("submission_uncertain");
      return Response.json({ status: "provider_accepted" });
    }
    throw new Error("Unexpected synthetic route");
  }) as typeof fetch;
  await cycle(config, state, async () => {
    saved = JSON.stringify(state);
  });
  expect(browserCalls).toBe(0);
  expect(dispatches).toBe(1);
  expect(state.emailCurrent).toBeUndefined();
  expect(state.current).toBeUndefined();
  expect(state.status).toContain("employer acknowledgment is pending");
});

test("a restarted email cycle reconciles a lost dispatch reply without browser checks or resend", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = fresh();
  let saved = "";
  let phase = "prepared";
  let dispatches = 0;
  let reconciles = 0;
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    expect(url.port).toBe("4101");
    paths.push(url.pathname);
    if (url.pathname === "/api/personal/campaigns")
      return Response.json({ items: [campaign], pagination: { total: 1 } });
    if (url.pathname.endsWith("/next")) return Response.json(leased);
    if (url.pathname === "/api/personal/attempts/attempt") return Response.json(observed(phase));
    if (url.pathname.endsWith("/dispatch")) {
      dispatches++;
      phase = "submitting";
      throw new Error("Synthetic lost response");
    }
    if (url.pathname.endsWith("/reconcile")) {
      reconciles++;
      phase = "submission_uncertain";
      return Response.json({ status: "provider_sent_verified" });
    }
    throw new Error("Unexpected synthetic route");
  }) as typeof fetch;
  const persist = async () => {
    saved = JSON.stringify(state);
  };
  await expect(cycle(config, state, persist)).rejects.toThrow("lost response");
  state = JSON.parse(saved);
  expect(state.emailCurrent?.dispatchRequested).toBe(true);
  const before = paths.length;
  await cycle(config, state, persist);
  expect(paths).toHaveLength(before);
  now += 30_000;
  await cycle(config, state, persist);
  expect(dispatches).toBe(1);
  expect(reconciles).toBe(1);
  expect(state.emailCurrent).toBeUndefined();
  expect(paths.filter((route) => route.endsWith("/campaigns"))).toHaveLength(1);
  expect(state.status).toContain("acknowledgment is pending");
});

test("server campaign-stop fence wins over cached active campaign before email dispatch", async () => {
  const state = fresh();
  state.emailCurrent = { leased, startedAt: Date.now(), dispatchRequested: false };
  state.campaignCache = [campaign];
  const routes: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    routes.push(url.pathname);
    if (url.pathname !== "/api/personal/attempts/attempt")
      throw new Error("No dispatch or browser access is permitted");
    return Response.json(observed("cancelled", 2));
  }) as typeof fetch;
  await cycle(config, state, async () => {});
  expect(routes).toEqual(["/api/personal/attempts/attempt"]);
  expect(state.emailCurrent).toBeUndefined();
  expect(state.status).toContain("cancelled");
});

test("stop between preparation read and dispatch rejection preserves intent until revoked lease readback", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = fresh();
  state.emailCurrent = { leased, startedAt: now, dispatchRequested: false };
  let saved = "";
  let stopped = false;
  let dispatches = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    expect(url.port).toBe("4101");
    if (url.pathname === "/api/personal/attempts/attempt")
      return Response.json(stopped ? observed("cancelled", 2) : observed("prepared"));
    if (url.pathname.endsWith("/dispatch")) {
      stopped = true;
      dispatches++;
      return new Response(null, { status: 409 });
    }
    throw new Error("Unexpected synthetic route");
  }) as typeof fetch;
  const persist = async () => {
    saved = JSON.stringify(state);
  };
  await expect(cycle(config, state, persist)).rejects.toThrow("HTTP 409");
  state = JSON.parse(saved);
  expect(state.emailCurrent?.dispatchRequested).toBe(true);
  now += 30_000;
  await cycle(config, state, persist);
  expect(dispatches).toBe(1);
  expect(state.emailCurrent).toBeUndefined();
  expect(state.status).toContain("cancelled");
});
