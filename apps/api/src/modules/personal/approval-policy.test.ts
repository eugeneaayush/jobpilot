import type { PersonalApprovalEvent } from "@jobpilot/contracts/personal-approval";
import {
  activeApproval,
  approvalExpiry,
  approvalHistory,
  approvalNonce,
  requireApprovalReceipt,
  requireDashboardOrigin,
  verifyApprovalNonce,
} from "./approval-policy";
import { manifestHash, readAttemptPolicy } from "./persistence-policy";
import { describe, expect, it } from "bun:test";

const now = new Date("2026-09-30T13:00:00.000Z");
const receipt = {
  id: crypto.randomUUID(),
  recordId: crypto.randomUUID(),
  campaignId: crypto.randomUUID(),
  campaignRunId: crypto.randomUUID(),
  packetArtifact: { path: "/synthetic/approval.json", sha256: manifestHash("synthetic") },
  packetHash: manifestHash({ answers: ["No"], document: "exact bytes" }),
  approvedAt: now.toISOString(),
  approvedRecordVersion: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
};
const approved: PersonalApprovalEvent = { kind: "approved", receipt };
const attemptId = crypto.randomUUID();
const bound: PersonalApprovalEvent = {
  kind: "bound",
  approvalId: receipt.id,
  attemptId,
  at: now.toISOString(),
};
const check = (events: PersonalApprovalEvent[], id?: string, hash = receipt.packetHash, at = now) =>
  activeApproval(events, hash, receipt.campaignId, receipt.campaignRunId, id, at);

describe("exact application approval", () => {
  it("requires an approval before reserving live work", () => {
    expect(() => check([])).toThrow("Review and approve");
    expect(check([approved])).toEqual(receipt);
  });
  it("binds approval to one attempt and rejects reuse after cancellation", () => {
    expect(check([approved, bound], attemptId)).toEqual(receipt);
    expect(() => check([approved, bound])).toThrow("another attempt");
    expect(() => check([approved, bound], crypto.randomUUID())).toThrow("another attempt");
    expect(() => check([approved], attemptId)).toThrow("no bound");
  });
  it("rejects any changed packet, campaign, or run", () => {
    expect(() => check([approved], undefined, manifestHash({ answers: ["Yes"] }))).toThrow("stale");
    expect(() =>
      activeApproval(
        [approved],
        receipt.packetHash,
        crypto.randomUUID(),
        receipt.campaignRunId,
        undefined,
        now,
      ),
    ).toThrow("stale");
    expect(() =>
      activeApproval(
        [approved],
        receipt.packetHash,
        receipt.campaignId,
        crypto.randomUUID(),
        undefined,
        now,
      ),
    ).toThrow("stale");
  });
  it("withdrawal and expiry fence a bound worker", () => {
    expect(() =>
      check(
        [approved, bound, { kind: "withdrawn", approvalId: receipt.id, at: now.toISOString() }],
        attemptId,
      ),
    ).toThrow("withdrawn");
    expect(() =>
      check([approved, bound], attemptId, receipt.packetHash, new Date(receipt.expiresAt)),
    ).toThrow("expired");
  });
  it("only the latest explicit review can authorize a new packet", () => {
    const newer = { ...receipt, id: crypto.randomUUID(), packetHash: manifestHash("new") };
    expect(() => check([approved, { kind: "approved", receipt: newer }])).toThrow("stale");
    expect(approvalHistory({ applicationApprovals: [approved, bound] })).toEqual([approved, bound]);
    expect(() =>
      approvalHistory({ applicationApprovals: [{ kind: "approved", actor: "user" }] }),
    ).toThrow("invalid");
    expect(() =>
      requireApprovalReceipt({ ...receipt, packetHash: manifestHash("forged") }, receipt),
    ).toThrow("does not match");
  });
  it("expires at the earlier of the local day boundary and 24 hours including DST", () => {
    expect(approvalExpiry("America/New_York", now).toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(
      approvalExpiry("America/New_York", new Date("2026-11-01T04:00:00.000Z")).toISOString(),
    ).toBe("2026-11-02T04:00:00.000Z");
    expect(
      approvalExpiry("America/New_York", new Date("2026-03-08T05:00:00.000Z")).toISOString(),
    ).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("dashboard confirmation boundary", () => {
  const origin = "http://localhost:4100";
  const params = [
    "secret",
    "cookie-token",
    receipt.recordId,
    receipt.recordId,
    now.toISOString(),
    receipt.packetHash,
  ] as const;
  it("rejects bearer authorization even with a valid dashboard origin", () => {
    expect(() =>
      requireDashboardOrigin({ origin, authorization: "Bearer agent-token" }, origin),
    ).toThrow("bearer");
    expect(() => requireDashboardOrigin({ origin: "https://attacker.test" }, origin)).toThrow(
      "origin",
    );
    expect(() => requireDashboardOrigin({}, origin)).toThrow("origin");
    expect(() =>
      requireDashboardOrigin({ origin, "sec-fetch-site": "cross-site" }, origin),
    ).toThrow("Cross-site");
    expect(() => requireDashboardOrigin({ origin }, origin)).not.toThrow();
    expect(() => requireDashboardOrigin({ referer: `${origin}/personal` }, origin, "POST")).toThrow(
      "origin",
    );
    expect(() =>
      requireDashboardOrigin({ referer: `${origin}/personal` }, origin, "GET"),
    ).not.toThrow();
  });
  it("binds nonces to the cookie session, record version, and exact packet", () => {
    const nonce = approvalNonce(...params);
    expect(() => verifyApprovalNonce(...params, nonce)).not.toThrow();
    expect(() =>
      verifyApprovalNonce(
        "secret",
        "other-cookie",
        ...(params.slice(2) as [string, string, string, string]),
        nonce,
      ),
    ).toThrow("another session");
    expect(() => verifyApprovalNonce(...params, `${nonce}x`)).toThrow("Invalid");
    expect(() => verifyApprovalNonce(...params, approvalNonce(...params, 1))).toThrow("expired");
    expect(() => verifyApprovalNonce(...params, "invalid")).toThrow("Invalid");
  });
  it("requires the migrated policy for live previews as well as submissions", () => {
    const personal = {
      enabled: true,
      dailyCap: 1,
      maxApplications: 1,
      timezone: "UTC",
      policyVersion: "1",
    };
    for (const mode of ["submit", "live_preview"])
      expect(() => readAttemptPolicy({ personal: { ...personal, mode } })).toThrow(
        "per-application",
      );
    expect(readAttemptPolicy({ personal: { ...personal, mode: "offline" } }).mode).toBe("offline");
  });
});
