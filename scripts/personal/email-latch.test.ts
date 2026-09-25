import { advanceApplicationEmail, type EmailExecution } from "./email";
import { afterEach, expect, test } from "bun:test";

/**
 * The emailCurrent latch: after three unresolved reconciliations the pilot used to hold the
 * global scheduler slot forever. These tests pin the release rule — stop local tracking only on
 * a known-expired lease; absent or malformed expiry fails closed, and a live lease, ours or a
 * foreign sender's, keeps tracking — plus the invariant that releasing is read-only, so an
 * uncertain mail can never be resent.
 */

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
  const emailCurrent: EmailExecution = {
    leased,
    dispatchRequested: true,
    startedAt: 1,
    reconcileAttempts: 3,
    // Backoff long past: only the exhausted budget decides.
    reconcileAfter: 1,
  };
  return { emailCurrent, status: "queued" } as {
    emailCurrent: EmailExecution | undefined;
    status: string;
  };
}

const observed = (state: string, leaseExpiresAt?: string) => ({
  state,
  leaseOwner: "owner",
  leaseGeneration: 1,
  ...(leaseExpiresAt !== undefined && { leaseExpiresAt }),
});

/** A read-only api: records every route so tests can prove no write ever left the release path. */
function readonly(overrides: () => Record<string, unknown>) {
  const calls: string[] = [];
  const api = async (route: string): Promise<unknown> => {
    calls.push(route);
    return overrides();
  };
  return { calls, api };
}

const past = new Date(0).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

test("an exhausted reconciliation budget stops local tracking only on a known-expired lease", async () => {
  for (const owner of ["own", "foreign"] as const) {
    const state = fixture();
    const { calls, api } = readonly(() =>
      owner === "own"
        ? observed("submitting", past)
        : { state: "submitting", leaseOwner: "other", leaseGeneration: 2, leaseExpiresAt: past },
    );
    await advanceApplicationEmail(state, api, async () => {});
    expect(calls).toEqual(["/personal/attempts/attempt"]);
    expect(state.emailCurrent).toBeUndefined();
    expect(state.status).toContain('"submitting" stays recorded');
    expect(state.status).toContain("local scheduler tracking is released");
    expect(state.status).toContain("resending stays disabled");
  }
});

test("a live lease retains tracking past the budget — ours or a foreign sender's", async () => {
  for (const snapshot of [
    observed("submitting", future()),
    { state: "submitting", leaseOwner: "other", leaseGeneration: 2, leaseExpiresAt: future() },
  ]) {
    const state = fixture();
    const { calls, api } = readonly(() => snapshot);
    await advanceApplicationEmail(state, api, async () => {});
    expect(calls).toEqual(["/personal/attempts/attempt"]);
    expect(state.emailCurrent).toBeDefined();
    expect(state.status).toContain("reconciliation is pending; no automatic resend");
  }
});

test("absent lease expiry is not proof of expiry: tracking is retained, fail closed", async () => {
  const state = fixture();
  const { calls, api } = readonly(() => observed("submitting"));
  await advanceApplicationEmail(state, api, async () => {});
  expect(calls).toEqual(["/personal/attempts/attempt"]);
  expect(state.emailCurrent).toBeDefined();
  expect(state.status).toContain("reconciliation is pending; no automatic resend");
});

test("malformed lease metadata fails closed without any write", async () => {
  const state = fixture();
  const { calls, api } = readonly(() => ({
    ...observed("submitting"),
    leaseExpiresAt: "not-a-date",
  }));
  await expect(advanceApplicationEmail(state, api, async () => {})).rejects.toThrow(
    "could not be verified",
  );
  expect(calls).toEqual(["/personal/attempts/attempt"]);
  expect(state.emailCurrent).toBeDefined();
});

test("a remaining reconciliation budget keeps waiting through the backoff window", async () => {
  const state = fixture();
  state.emailCurrent!.reconcileAttempts = 1;
  state.emailCurrent!.reconcileAfter = Date.now() + 60_000;
  const { calls, api } = readonly(() => observed("submitting", future()));
  await advanceApplicationEmail(state, api, async () => {});
  expect(calls).toEqual(["/personal/attempts/attempt"]);
  expect(state.emailCurrent).toBeDefined();
  expect(state.status).toContain("reconciliation is pending; no automatic resend");
});

test("an exhausted park budget stops local tracking only once the lease is known-expired", async () => {
  const held = fixture();
  Object.assign(held.emailCurrent!, { parkAttempts: 3, parkAfter: 1 });
  const holding = readonly(() => observed("prepared", future()));
  await advanceApplicationEmail(held, holding.api, async () => {});
  expect(holding.calls).toEqual(["/personal/attempts/attempt", "/personal/attempts/attempt"]);
  expect(held.emailCurrent).toBeDefined();
  expect(held.status).toContain("recovery remains unresolved; no automatic resend");

  let reads = 0;
  const released = fixture();
  Object.assign(released.emailCurrent!, { parkAttempts: 3, parkAfter: 1 });
  const dying = readonly(() => {
    reads += 1;
    return observed("prepared", reads === 1 ? future() : past);
  });
  await advanceApplicationEmail(released, dying.api, async () => {});
  expect(dying.calls).toEqual(["/personal/attempts/attempt", "/personal/attempts/attempt"]);
  expect(released.emailCurrent).toBeUndefined();
  expect(released.status).toContain("local scheduler tracking is released");
});

test("an unrecognized attempt state holds under a live lease and releases on a known-expired one", async () => {
  const held = fixture();
  const holding = readonly(() => observed("queued", future()));
  await advanceApplicationEmail(held, holding.api, async () => {});
  expect(holding.calls).toEqual(["/personal/attempts/attempt"]);
  expect(held.emailCurrent).toBeDefined();
  expect(held.status).toContain("dispatch remains held");

  const released = fixture();
  const dead = readonly(() => observed("queued", past));
  await advanceApplicationEmail(released, dead.api, async () => {});
  expect(dead.calls).toEqual(["/personal/attempts/attempt"]);
  expect(released.emailCurrent).toBeUndefined();
  expect(released.status).toContain('"queued" stays recorded');
  expect(released.status).toContain("local scheduler tracking is released");
});
