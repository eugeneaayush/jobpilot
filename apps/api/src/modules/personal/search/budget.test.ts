import { policyMonthWindow } from "./budget";
import { describe, expect, test } from "bun:test";

describe("personal spend policy calendar", () => {
  test("uses the policy month rather than UTC across month boundaries", () => {
    const window = policyMonthWindow("America/New_York", new Date("2026-10-01T02:00:00Z"));
    expect(window.month).toBe("2026-09");
    expect(window.start.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-01T04:00:00.000Z");
  });
  test("month boundaries honor daylight saving and year rollover", () => {
    const dst = policyMonthWindow("America/New_York", new Date("2026-03-20T12:00:00Z"));
    expect(dst.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(dst.end.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    const rollover = policyMonthWindow("Asia/Tokyo", new Date("2026-12-31T18:00:00Z"));
    expect(rollover.month).toBe("2027-01");
    expect(rollover.start.toISOString()).toBe("2026-12-31T15:00:00.000Z");
  });
  test("invalid policy timezones fail closed", () => {
    expect(() => policyMonthWindow("invalid/timezone", new Date())).toThrow();
  });
});
