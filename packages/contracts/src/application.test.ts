import {
  applicationEventKindSchema,
  applicationEventSourceSchema,
  applicationFilterSchema,
  applicationSourceSchema,
  SINGLE_APPLY_CAMPAIGN,
  statusSchema,
  statusTransitionSchema,
} from "./application";
import { describe, expect, it } from "bun:test";

describe("statusSchema", () => {
  it("accepts the six pipeline statuses and nothing else", () => {
    for (const status of [
      "applied",
      "screening",
      "interviewing",
      "offer",
      "rejected",
      "withdrawn",
    ]) {
      expect(statusSchema.safeParse(status).success).toBe(true);
    }
    expect(statusSchema.safeParse("hired").success).toBe(false);
  });
});

describe("applicationSourceSchema", () => {
  it("accepts the five origins and rejects an unknown one", () => {
    expect(applicationSourceSchema.safeParse("auto_apply").success).toBe(true);
    expect(applicationSourceSchema.safeParse("networking").success).toBe(true);
    expect(applicationSourceSchema.safeParse("referral").success).toBe(false);
  });
});

describe("event schemas", () => {
  it("enforce the closed event vocabularies", () => {
    expect(applicationEventKindSchema.safeParse("note").success).toBe(true);
    expect(applicationEventKindSchema.safeParse("call").success).toBe(false);
    expect(applicationEventSourceSchema.safeParse("campaign").success).toBe(true);
    expect(applicationEventSourceSchema.safeParse("agent").success).toBe(false);
  });
});

describe("statusTransitionSchema", () => {
  it("requires a known toStatus and allows an optional, nullable note", () => {
    expect(statusTransitionSchema.parse({ toStatus: "offer" })).toEqual({ toStatus: "offer" });
    expect(statusTransitionSchema.parse({ toStatus: "offer", note: null })).toEqual({
      toStatus: "offer",
      note: null,
    });
    expect(statusTransitionSchema.safeParse({ toStatus: "hired" }).success).toBe(false);
    expect(statusTransitionSchema.safeParse({}).success).toBe(false);
  });
});

describe("applicationFilterSchema", () => {
  it("keeps only non-blank, trimmed text filters", () => {
    expect(applicationFilterSchema.parse({ search: "  backend  " })).toEqual({ search: "backend" });
    expect(applicationFilterSchema.safeParse({ search: "   " }).success).toBe(false);
    expect(applicationFilterSchema.safeParse({ board: "" }).success).toBe(false);
    expect(applicationFilterSchema.parse({})).toEqual({});
  });

  it("accepts the no-campaign sentinel as a campaignId", () => {
    expect(applicationFilterSchema.parse({ campaignId: SINGLE_APPLY_CAMPAIGN })).toEqual({
      campaignId: "none",
    });
  });

  it("rejects an unknown status or source", () => {
    expect(applicationFilterSchema.safeParse({ status: "hired" }).success).toBe(false);
    expect(applicationFilterSchema.safeParse({ source: "referral" }).success).toBe(false);
  });
});
