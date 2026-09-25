import { advanceApplicationEmail, type EmailExecution } from "./email";
import { afterEach, expect, test } from "bun:test";

const originalNow = Date.now;
afterEach(() => {
  Date.now = originalNow;
});

function fixture() {
  const leased = {
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
      title: "Synthetic MBA role",
      company: "Fixture",
      url: "https://example.test/job",
      track: "mba_internship",
    },
    task: {
      kind: "apply",
      attemptId: "attempt",
      brokerPath: "/fixture",
      applicationMethod: "official_email",
    },
  } as EmailExecution["leased"];
  return {
    emailCurrent: { leased, dispatchRequested: false, startedAt: 1 } as EmailExecution | undefined,
    status: "queued",
  };
}
const observed = (state = "prepared") => ({ state, leaseOwner: "owner", leaseGeneration: 1 });

test("email dispatch persists intent before transport and never resends after a lost response", async () => {
  const state = fixture();
  let saved = false;
  let now = 1_000_000;
  Date.now = () => now;
  let phase = "prepared";
  const calls: string[] = [];
  const api = async (route: string) => {
    calls.push(route);
    if (route.endsWith("/dispatch")) {
      expect(saved).toBe(true);
      throw new Error("Synthetic lost response");
    }
    if (route.endsWith("/park")) phase = "blocked";
    return observed(phase);
  };
  await expect(
    advanceApplicationEmail(state, api, async () => {
      saved = state.emailCurrent!.dispatchRequested;
    }),
  ).rejects.toThrow("lost response");
  now += 30_000;
  await advanceApplicationEmail(state, api, async () => {});
  expect(calls.filter((v) => v.endsWith("/dispatch"))).toHaveLength(1);
  expect(calls.filter((v) => v.endsWith("/park"))).toHaveLength(1);
  expect(state.emailCurrent).toBeUndefined();
});

for (const phase of ["submitting", "submission_uncertain"]) {
  test(`${phase} email reconciles without another dispatch`, async () => {
    const state = fixture();
    const calls: string[] = [];
    let latest = phase;
    await advanceApplicationEmail(
      state,
      async (route) => {
        calls.push(route);
        if (route.endsWith("/reconcile")) {
          latest = "submission_uncertain";
          return { status: "provider_accepted" };
        }
        return observed(latest);
      },
      async () => {},
    );
    expect(calls.some((v) => v.endsWith("/dispatch"))).toBe(false);
    expect(calls.filter((v) => v.endsWith("/reconcile"))).toHaveLength(1);
    expect(state.status).toContain("acknowledgment is pending");
    expect(state.emailCurrent).toBeUndefined();
  });
}

test("missing email setup parks only its own pre-submission lease", async () => {
  const state = fixture();
  const calls: string[] = [];
  let phase = "prepared";
  await advanceApplicationEmail(
    state,
    async (route) => {
      calls.push(route);
      if (route.endsWith("/park")) phase = "blocked";
      return route.endsWith("/dispatch")
        ? { status: "blocked", reason: "Missing configured account" }
        : observed(phase);
    },
    async () => {},
  );
  expect(calls.filter((v) => v.endsWith("/park"))).toHaveLength(1);
  expect(state.emailCurrent).toBeUndefined();
});

test("a dispatch response does not clear unresolved submitting state or claim employer acknowledgment", async () => {
  const state = fixture();
  let phase = "prepared";
  await advanceApplicationEmail(
    state,
    async (route) => {
      if (route.endsWith("/dispatch")) {
        phase = "submitting";
        return { status: "provider_accepted" };
      }
      return observed(phase);
    },
    async () => {},
  );
  expect(state.emailCurrent?.dispatchRequested).toBe(true);
  expect(state.status).toContain("unresolved");
  expect(state.status).not.toContain("acknowledgment recorded");
});

test("reconciliation intent and bounded exponential backoff survive restart without resending", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state = fixture();
  state.emailCurrent!.dispatchRequested = true;
  let saved = "";
  let reconciles = 0;
  let requests = 0;
  const persist = async () => {
    saved = JSON.stringify(state);
  };
  const api = async (route: string) => {
    requests++;
    expect(route).not.toEndWith("/dispatch");
    if (route.endsWith("/reconcile")) {
      reconciles++;
      expect(JSON.parse(saved).emailCurrent.reconcileAttempts).toBe(reconciles);
      throw new Error("Synthetic unavailable receipt");
    }
    // Known-expired lease: the only signal that safely stops local tracking after the budget.
    return { ...observed("submitting"), leaseExpiresAt: new Date(0).toISOString() };
  };
  for (const delay of [60_000, 120_000, 240_000]) {
    await expect(advanceApplicationEmail(state, api, persist)).rejects.toThrow("unavailable");
    expect(state.emailCurrent?.reconcileAfter).toBe(now + delay);
    state = JSON.parse(saved);
    const prior = requests;
    now += delay - 1;
    await advanceApplicationEmail(state, api, persist);
    expect(requests).toBe(prior);
    now++;
  }
  await advanceApplicationEmail(state, api, persist);
  expect(reconciles).toBe(3);
  expect(state.emailCurrent).toBeUndefined();
  expect(state.status).toContain("local scheduler tracking is released");
});

test("a lost park response clears only an authoritative settled readback", async () => {
  for (const after of ["blocked", "prepared"]) {
    const state = fixture();
    state.emailCurrent!.dispatchRequested = true;
    let phase = "prepared";
    const api = async (route: string, body?: unknown) => {
      expect(route).not.toEndWith("/dispatch");
      if (route.endsWith("/park")) {
        expect(body).toMatchObject({ leaseOwner: "owner", leaseGeneration: 1 });
        phase = after;
        throw new Error("Synthetic lost park response");
      }
      return observed(phase);
    };
    const work = advanceApplicationEmail(state, api, async () => {});
    if (after === "prepared") {
      await expect(work).rejects.toThrow("lost park");
      expect(state.emailCurrent?.parkAttempts).toBe(1);
    } else {
      await work;
      expect(state.emailCurrent).toBeUndefined();
    }
  }
});

test("stop or lease change after blocked dispatch is observed without parking another owner", async () => {
  for (const after of [
    { ...observed("cancelled"), leaseGeneration: 2 },
    { ...observed(), leaseOwner: "other-owner", leaseGeneration: 2 },
  ]) {
    const state = fixture();
    let dispatched = false;
    const calls: string[] = [];
    await advanceApplicationEmail(
      state,
      async (route) => {
        calls.push(route);
        if (route.endsWith("/dispatch")) {
          dispatched = true;
          return { status: "blocked", reason: "private-canary" };
        }
        return dispatched ? after : observed();
      },
      async () => {},
    );
    expect(calls.some((route) => route.endsWith("/park"))).toBe(false);
    expect(state.emailCurrent).toBeUndefined();
    expect(state.status).not.toContain("private-canary");
  }
});

test("failed intent persistence and expired lease cannot dispatch", async () => {
  const state = fixture();
  let calls = 0;
  await expect(
    advanceApplicationEmail(
      state,
      async () => {
        calls++;
        return observed();
      },
      async () => {
        throw new Error("Synthetic persistence failed");
      },
    ),
  ).rejects.toThrow("persistence failed");
  expect(calls).toBe(0);
  const expired = fixture();
  await advanceApplicationEmail(
    expired,
    async (route) => {
      expect(route).toBe("/personal/attempts/attempt");
      return { ...observed(), leaseExpiresAt: new Date(0).toISOString() };
    },
    async () => {},
  );
  expect(expired.emailCurrent).toBeUndefined();
  expect(expired.status).toContain("expired");
});

test("changed lease and already submitted outcomes never dispatch", async () => {
  for (const snapshot of [observed("submitted"), { ...observed(), leaseGeneration: 2 }]) {
    const state = fixture();
    let count = 0;
    await advanceApplicationEmail(
      state,
      async () => {
        count++;
        return snapshot;
      },
      async () => {},
    );
    expect(count).toBe(1);
    expect(state.emailCurrent).toBeUndefined();
  }
});
