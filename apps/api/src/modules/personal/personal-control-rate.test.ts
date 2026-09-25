import { type RateLimitContext, rateLimit } from "@/common/rate-limit/limiter";
import { RATE_LIMITS } from "@/common/rate-limit/policies";
import { describe, expect, spyOn, test } from "bun:test";

const context = (userId: string): RateLimitContext => ({
  request: new Request("http://localhost/api/personal/attempts/synthetic"),
  server: null,
  headers: { "x-real-ip": "127.0.0.1" },
  user: { id: userId },
});
function logicalClock(work: (advance: (ms: number) => void) => void) {
  let now = 1_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    work((ms) => {
      now += ms;
    });
  } finally {
    clock.mockRestore();
  }
}
function denial(work: () => void): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("personal attempt control rate budgets", () => {
  test("a fast 100-field form and fifteen-second heartbeats preserve final mutation capacity", () => {
    logicalClock((advance) => {
      const read = rateLimit(RATE_LIMITS.personalAttemptControl);
      const checkpoint = rateLimit(RATE_LIMITS.personalAttemptControl);
      const beginSubmit = rateLimit(RATE_LIMITS.pilotClaim);
      const receipt = rateLimit(RATE_LIMITS.pilotClaim);
      const user = context("synthetic-owner");
      expect(() => {
        for (let field = 0; field < 100; field++) {
          read(user);
          read(user);
          if (field % 10 === 0) checkpoint(user);
        }
        // Inspection, upload and final evidence checks also read the current lease.
        for (let check = 0; check < 30; check++) read(user);
        for (let heartbeat = 0; heartbeat < 240; heartbeat++) {
          advance(15_000);
          checkpoint(user);
          read(user);
        }
        beginSubmit(user);
        receipt(user);
      }).not.toThrow();
    });
  });
  test("read bursts remain finite and replenish at the configured sustained rate", () => {
    logicalClock((advance) => {
      const read = rateLimit(RATE_LIMITS.personalAttemptControl);
      const user = context("synthetic-owner");
      for (let i = 0; i < RATE_LIMITS.personalAttemptControl.burst; i++) read(user);
      expect(denial(() => read(user))).toMatchObject({
        status: 429,
        headers: { "retry-after": "1" },
      });
      advance(999);
      expect(denial(() => read(user))).toMatchObject({ status: 429 });
      advance(1);
      expect(() => read(user)).not.toThrow();
      expect(denial(() => read(user))).toMatchObject({ status: 429 });
    });
  });
  test("control buckets are isolated by authenticated user even on the same loopback IP", () => {
    logicalClock(() => {
      const read = rateLimit(RATE_LIMITS.personalAttemptControl);
      const owner = context("owner");
      const other = context("other");
      for (let i = 0; i < RATE_LIMITS.personalAttemptControl.burst; i++) read(owner);
      expect(denial(() => read(owner))).toMatchObject({ status: 429 });
      expect(() => read(other)).not.toThrow();
      expect(denial(() => read(owner))).toMatchObject({ status: 429 });
    });
  });
  test("exhausted reads cannot spend heartbeat or any independent mutation-route tokens", () => {
    logicalClock(() => {
      const read = rateLimit(RATE_LIMITS.personalAttemptControl);
      const checkpoint = rateLimit(RATE_LIMITS.personalAttemptControl);
      const start = rateLimit(RATE_LIMITS.pilotClaim);
      const beginSubmit = rateLimit(RATE_LIMITS.pilotClaim);
      const receipt = rateLimit(RATE_LIMITS.pilotClaim);
      const user = context("owner");
      for (let i = 0; i < RATE_LIMITS.personalAttemptControl.burst; i++) read(user);
      for (let i = 0; i < RATE_LIMITS.pilotClaim.burst; i++) start(user);
      expect(denial(() => read(user))).toMatchObject({ status: 429 });
      expect(denial(() => start(user))).toMatchObject({ status: 429 });
      expect(() => {
        checkpoint(user);
        beginSubmit(user);
        receipt(user);
      }).not.toThrow();
    });
  });
  test("submission mutations retain the original tighter pilot limit", () => {
    logicalClock((advance) => {
      expect(RATE_LIMITS.pilotClaim.limit).toBe(240);
      expect(RATE_LIMITS.pilotClaim.burst).toBe(10);
      const submit = rateLimit(RATE_LIMITS.pilotClaim);
      const user = context("owner");
      for (let i = 0; i < 10; i++) submit(user);
      expect(denial(() => submit(user))).toMatchObject({
        status: 429,
        headers: { "retry-after": "15" },
      });
      advance(15_000);
      expect(() => submit(user)).not.toThrow();
    });
  });
  test("campaign polling and scheduling cannot exhaust stop capacity", () => {
    logicalClock(() => {
      const read = rateLimit(RATE_LIMITS.personalCampaignRead);
      const schedule = rateLimit(RATE_LIMITS.personalCampaignSchedule);
      const stop = rateLimit(RATE_LIMITS.personalCampaignStop);
      const owner = context("owner");
      for (let i = 0; i < RATE_LIMITS.personalCampaignRead.burst; i++) read(owner);
      for (let i = 0; i < RATE_LIMITS.personalCampaignSchedule.burst; i++) schedule(owner);
      expect(denial(() => read(owner))).toMatchObject({ status: 429 });
      expect(denial(() => schedule(owner))).toMatchObject({ status: 429 });
      expect(() => stop(owner)).not.toThrow();
      for (let i = 1; i < RATE_LIMITS.personalCampaignStop.burst; i++) stop(owner);
      expect(denial(() => stop(owner))).toMatchObject({ status: 429 });
      expect(() => stop(context("other-owner"))).not.toThrow();
    });
  });
  test("eight hours of polling and twenty idle campaigns preserve independent controls", () => {
    logicalClock((advance) => {
      const read = rateLimit(RATE_LIMITS.personalCampaignRead);
      const schedule = rateLimit(RATE_LIMITS.personalCampaignSchedule);
      const stop = rateLimit(RATE_LIMITS.personalCampaignStop);
      const checkpoint = rateLimit(RATE_LIMITS.personalAttemptControl);
      const owner = context("owner");
      expect(() => {
        for (let tick = 0; tick < 8 * 60 * 4; tick++) {
          read(owner);
          checkpoint(owner);
          if (tick % 20 === 0) for (let campaign = 0; campaign < 20; campaign++) schedule(owner);
          if (tick % 240 === 0) stop(owner);
          advance(15_000);
        }
      }).not.toThrow();
    });
  });
});
