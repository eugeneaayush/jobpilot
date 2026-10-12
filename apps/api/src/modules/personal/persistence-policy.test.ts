import {
  guardLegacyPersonalSubmission,
  manifestHash,
  policyDay,
  readAttemptPolicy,
  trustedRequisition,
} from "./persistence-policy";
import { afterEach, describe, expect, it } from "bun:test";

const previousMode = process.env.PERSONAL_MODE;
afterEach(() => {
  if (previousMode === undefined) delete process.env.PERSONAL_MODE;
  else process.env.PERSONAL_MODE = previousMode;
});

describe("personal persistence policy", () => {
  it("hashes the same immutable manifest regardless of object insertion order", () => {
    expect(manifestHash({ b: [1, { z: true, a: "x" }], a: 2 })).toBe(
      manifestHash({ a: 2, b: [1, { a: "x", z: true }] }),
    );
    expect(manifestHash({ a: [1, 2] })).not.toBe(manifestHash({ a: [2, 1] }));
  });
  it("uses local calendar days across daylight-saving boundaries", () => {
    expect(policyDay("America/New_York", new Date("2026-03-08T04:59:59Z"))).toBe("2026-03-07");
    expect(policyDay("America/New_York", new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(policyDay("America/New_York", new Date("2026-03-09T04:00:00Z"))).toBe("2026-03-09");
  });
  it("requires an explicit enabled, bounded campaign policy", () => {
    expect(() => readAttemptPolicy({})).toThrow("explicit enabled");
    const personal = {
      enabled: true,
      mode: "offline",
      dailyCap: 1,
      maxApplications: 2,
      timezone: "America/New_York",
      policyVersion: "v1",
    } as const;
    expect(readAttemptPolicy({ personal })).toEqual(personal);
    expect(() => readAttemptPolicy({ personal: { ...personal, dailyCap: 0 } })).toThrow();
    expect(() =>
      readAttemptPolicy({ personal: { ...personal, timezone: "Unknown/Zone" } }),
    ).toThrow("timezone");
  });
  it("separates stable posting identity from employer job and requisition reservation keys", () => {
    const posting = {
      source: "greenhouse",
      boardToken: "example",
      nativeId: "123",
      employer: "Example",
      url: "https://example.test/jobs/123",
    };
    const record = {
      identity: "greenhouse:example:123",
      requisitionId: "123",
      company: "Example",
      url: posting.url,
    };
    const identity = (details: object) =>
      trustedRequisition({ ...record, details: { posting: { ...posting, ...details } } });
    expect(identity({ internalJobId: "456", requisitionId: "REQ:9" })).toMatchObject({
      identity: record.identity,
      requisitionId: "123",
      submissionIdentity: "greenhouse:example:job:456",
    });
    expect(identity({ raw: { internal_job_id: 456 } }).submissionIdentity).toBe(
      "greenhouse:example:job:456",
    );
    expect(identity({ internalJobId: null, requisitionId: "REQ:9" }).submissionIdentity).toBe(
      "greenhouse:example:req:REQ%3A9",
    );
    expect(identity({ raw: { requisition_id: "REQ:9" } }).submissionIdentity).toBe(
      "greenhouse:example:req:REQ%3A9",
    );
    expect(identity({}).submissionIdentity).toBe("greenhouse:example:post:123");
  });
  it("retains scoped sources and tracks in immutable attempt policy", () => {
    const personal: ReturnType<typeof readAttemptPolicy> = {
      enabled: true,
      mode: "submit",
      approvalPolicy: "per-application-v1",
      dailyCap: 1,
      maxApplications: 3,
      timezone: "America/New_York",
      policyVersion: "scope-v1",
      roleScope: { internshipOnly: true, categories: ["mbb_consulting"] },
      sources: { boardTokens: ["example"] },
      tracks: ["general_professional"],
    };
    expect(readAttemptPolicy({ personal })).toEqual(personal);
    expect(() => readAttemptPolicy({ personal: { ...personal, sources: undefined } })).toThrow(
      "explicit recruiting tracks and sources",
    );
    expect(() => readAttemptPolicy({ personal: { ...personal, tracks: undefined } })).toThrow(
      "explicit recruiting tracks and sources",
    );
  });
  it("blocks the legacy path only in explicit personal mode", () => {
    delete process.env.PERSONAL_MODE;
    expect(guardLegacyPersonalSubmission).not.toThrow();
    process.env.PERSONAL_MODE = "false";
    expect(guardLegacyPersonalSubmission).not.toThrow();
    process.env.PERSONAL_MODE = "true";
    expect(guardLegacyPersonalSubmission).toThrow("personal attempt broker");
  });
});
