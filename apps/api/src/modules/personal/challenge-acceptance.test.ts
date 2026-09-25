import { type ChallengeLedger, validateChallengeAcceptance } from "./challenge-policy";
import { describe, expect, test } from "bun:test";

const attempt = { id: crypto.randomUUID(), manifestHash: "a".repeat(64) };
const target = "https://boards.greenhouse.io/synthetic/jobs/123";
const at = "2026-09-16T10:00:00.000Z";
const later = "2026-09-16T10:01:00.000Z";
function fixture() {
  const ledger: ChallengeLedger = {
    version: 1,
    transport: {
      manifestHash: attempt.manifestHash,
      targetUrl: target,
      applicationPayloadHash: "b".repeat(64),
      requestBodyHash: "c".repeat(64),
      evidenceHash: "d".repeat(64),
      fingerprintHash: "e".repeat(64),
      capturedAt: at,
    },
    current: null,
    events: [],
  };
  const transport = {
    targetUrl: target,
    applicationPayloadHash: ledger.transport.applicationPayloadHash,
    requestBodyHash: ledger.transport.requestBodyHash,
    responseStatus: 200,
    responseBody: "{}",
    capturedAt: later,
  };
  const evidence = { capturedAt: later, sourceUrl: `${target}/confirmation` };
  const artifact = {
    attemptId: attempt.id,
    manifestHash: attempt.manifestHash,
    capturedAt: later,
    sourceUrl: evidence.sourceUrl,
    transport,
  };
  return { ledger, transport, evidence, artifact };
}
describe("pinned Greenhouse acceptance evidence", () => {
  test("requires actual correlated initial transport plus the exact posting confirmation", () => {
    const f = fixture();
    expect(() =>
      validateChallengeAcceptance(f.ledger, attempt, f.artifact, f.evidence),
    ).not.toThrow();
    for (const transport of [
      undefined,
      { ...f.transport, requestBodyHash: "f".repeat(64) },
      { ...f.transport, applicationPayloadHash: "f".repeat(64) },
      { ...f.transport, targetUrl: target.replace("123", "999") },
      { ...f.transport, responseStatus: 422 },
      { ...f.transport, responseBody: '{"code":"captcha-failed"}' },
      { ...f.transport, responseBody: '{"error":"no"}' },
      { ...f.transport, responseBody: "<html>Not an acceptance</html>" },
    ])
      expect(() =>
        validateChallengeAcceptance(f.ledger, attempt, { ...f.artifact, transport }, f.evidence),
      ).toThrow();
    expect(() =>
      validateChallengeAcceptance(f.ledger, attempt, f.artifact, {
        ...f.evidence,
        sourceUrl: `${target.replace("123", "999")}/confirmation`,
      }),
    ).toThrow();
  });
  test("an unresolved challenge can settle only with its consumed exact permit request", () => {
    const f = fixture();
    const challengeId = crypto.randomUUID();
    const permitId = crypto.randomUUID();
    f.ledger.current = {
      challengeId,
      code: "captcha-failed",
      status: "continuing",
      hasRecipient: true,
      leaseOwner: "owner",
      leaseGeneration: 1,
      leaseExpiresAt: later,
      createdAt: at,
      expiresAt: later,
      evidenceHash: "f".repeat(64),
      permit: {
        permitId,
        status: "consumed",
        expiresAt: later,
        requestBodyHash: "1".repeat(64),
        evidenceHash: "2".repeat(64),
      },
    };
    f.ledger.events.push({ kind: "consumed", at, data: { permitId } });
    const artifact = {
      schemaVersion: 1,
      kind: "greenhouse_verification_response",
      attemptId: attempt.id,
      manifestHash: attempt.manifestHash,
      challengeId,
      permitId,
      ...f.transport,
      requestBodyHash: f.ledger.current.permit!.requestBodyHash,
    };
    const evidence = { ...f.evidence, sourceUrl: target };
    expect(() => validateChallengeAcceptance(f.ledger, attempt, artifact, evidence)).not.toThrow();
    for (const changed of [
      { permitId: crypto.randomUUID() },
      { challengeId: crypto.randomUUID() },
      { requestBodyHash: f.ledger.transport.requestBodyHash },
      { responseStatus: 400 },
      { capturedAt: "2026-09-16T09:00:00.000Z" },
    ])
      expect(() =>
        validateChallengeAcceptance(f.ledger, attempt, { ...artifact, ...changed }, evidence),
      ).toThrow();
    f.ledger.current.status = "permitted";
    expect(() => validateChallengeAcceptance(f.ledger, attempt, artifact, evidence)).toThrow(
      "consumed",
    );
  });
});
