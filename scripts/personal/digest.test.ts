import type { RuntimeConfig } from "./common";
import { type DigestPollState, tickDigest } from "./digest";
import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});
const config = { account: { token: "synthetic-token" } } as RuntimeConfig;

test("minute polling persists before HTTP and survives restart without duplicate checks", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state: DigestPollState = {};
  let saved = "";
  let calls = 0;
  const persist = async () => {
    saved = JSON.stringify(state);
  };
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("http://localhost:4101/api/personal/digest/tick");
    expect(JSON.parse(saved).lastCheckAt).toBe(now);
    expect(JSON.parse(saved).nextCheckAt).toBe(now + 60_000);
    expect(init?.body).toBe("{}");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    calls++;
    return Response.json({ status: "not_due" });
  }) as typeof fetch;
  await tickDigest(config, state, persist, now);
  state = JSON.parse(saved);
  for (let i = 0; i < 3; i++) {
    now += 15_000;
    await tickDigest(config, state, persist, now);
  }
  expect(calls).toBe(1);
  now += 15_000;
  await tickDigest(config, state, persist, now);
  expect(calls).toBe(2);
  expect(state.lastStatus).toBe("not_due");
});

test("429 cooldown is persisted without throwing raw service errors or repeating early", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let state: DigestPollState = {};
  let saved = "";
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request) => {
    calls++;
    return new Response("private-canary", { status: 429, headers: { "retry-after": "600" } });
  }) as typeof fetch;
  const persist = async () => {
    saved = JSON.stringify(state);
  };
  await tickDigest(config, state, persist, now);
  expect(state.lastStatus).toBe("unavailable");
  expect(state.nextCheckAt).toBe(now + 600_000);
  expect(saved).not.toContain("private-canary");
  state = JSON.parse(saved);
  now += 60_000;
  await tickDigest(config, state, persist, now);
  expect(calls).toBe(1);
});

test("failed persistence prevents dispatch and an unavailable API does not block the pilot", async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request) => {
    calls++;
    throw new Error("private-network-canary");
  }) as unknown as typeof fetch;
  await expect(
    tickDigest(config, {}, async () => {
      throw new Error("synthetic persistence failed");
    }),
  ).rejects.toThrow("persistence failed");
  expect(calls).toBe(0);
  const state: DigestPollState = {};
  await tickDigest(config, state, async () => {});
  expect(calls).toBe(1);
  expect(state.lastStatus).toBe("unavailable");
  expect(JSON.stringify(state)).not.toContain("private");
});
