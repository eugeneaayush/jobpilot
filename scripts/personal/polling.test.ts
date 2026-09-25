import { LocalHttpError, retryAfterMilliseconds } from "./common";
import {
  beginDiscovery,
  checkCooldown,
  delayRequest,
  finishDiscovery,
  idlePoll,
  newPollingState,
  requestBucket,
  sourcePoll,
} from "./polling";
import { expect, test } from "bun:test";

test("Retry-After accepts seconds and HTTP dates while rejecting malformed and unsafe values", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  expect(retryAfterMilliseconds("120", now)).toBe(120_000);
  expect(retryAfterMilliseconds("Wed, 16 Sep 2026 12:02:00 GMT", now)).toBe(120_000);
  expect(retryAfterMilliseconds("Wed, 16 Sep 2026 11:59:00 GMT", now)).toBe(0);
  for (const value of [null, "", "1.5", "-5", "NaN", "tomorrow", "99999999999999999999"])
    expect(retryAfterMilliseconds(value, now)).toBeUndefined();
  const error = new LocalHttpError(429, "api", "/personal/campaigns?private=canary", "GET", "120");
  expect(error.status).toBe(429);
  expect(error.retryAfterMs).toBe(120_000);
  expect(error.message).not.toContain("canary");
});

test("idle backoff is bounded and persisted without a restart burst", () => {
  let poll: ReturnType<typeof idlePoll> | undefined;
  let now = 0;
  const delays: number[] = [];
  for (let index = 0; index < 8; index++) {
    poll = idlePoll(poll, now);
    delays.push(poll.nextAt - now);
    now = poll.nextAt;
    poll = JSON.parse(JSON.stringify(poll));
  }
  expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("cooldowns follow server route buckets and do not suppress unrelated heartbeats or stops", () => {
  const polling = newPollingState();
  const list = requestBucket("api", "GET", "/personal/campaigns?page=1");
  delayRequest(polling, list, 120_000);
  delayRequest(polling, list, 60_000);
  expect(() => checkCooldown(polling, list, 100_000)).toThrow();
  expect(() =>
    checkCooldown(
      polling,
      requestBucket("api", "POST", "/personal/attempts/a/checkpoint"),
      100_000,
    ),
  ).not.toThrow();
  expect(() =>
    checkCooldown(polling, requestBucket("api", "POST", "/personal/campaigns/a/stop"), 100_000),
  ).not.toThrow();
  expect(requestBucket("api", "POST", "/personal/campaigns/a/next")).toBe(
    requestBucket("api", "POST", "/personal/campaigns/b/next"),
  );
  expect(requestBucket("api", "POST", "/personal/discover")).not.toBe(
    requestBucket("api", "GET", "/personal?page=5"),
  );
  expect(requestBucket("api", "POST", "/personal/a/preview")).not.toBe(
    requestBucket("api", "POST", "/personal/discover"),
  );
  checkCooldown(polling, list, 120_000);
  expect(polling.cooldowns[list]).toBeUndefined();
});

test("legacy discovery attempts and partial responses never fabricate successful refreshes", () => {
  const polling = newPollingState();
  const source = sourcePoll(polling, "greenhouse:fixture", 1000);
  expect(source).toEqual({ attemptedAt: 1000, nextAttemptAt: 3_601_000, failures: 0 });
  beginDiscovery(source, 4_000_000);
  expect(source.nextAttemptAt).toBe(7_600_000);
  finishDiscovery(source, { status: "partial" }, 4_000_000);
  expect(source.succeededAt).toBeUndefined();
  expect(source.outcome).toBe("partial");
  expect(source.nextAttemptAt).toBe(4_060_000);
  finishDiscovery(source, { status: "complete" }, 5_000_000);
  expect(source.succeededAt).toBe(5_000_000);
  finishDiscovery(
    source,
    { status: "blocked", nextEligibleAt: new Date(20_000_000).toISOString() },
    6_000_000,
    15_000_000,
  );
  expect(source.succeededAt).toBe(5_000_000);
  expect(source.nextAttemptAt).toBe(20_000_000);
  expect(source.failures).toBe(1);
});
