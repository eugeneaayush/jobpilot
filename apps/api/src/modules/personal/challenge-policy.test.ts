import { createHash } from "node:crypto";
import { personalChallengeResponseSchema } from "@jobpilot/contracts/personal-challenge";
import {
  challengeRequest,
  challengeResponse,
  challengeResponseArtifactSchema,
} from "./challenge-policy";
import { describe, expect, test } from "bun:test";

const identity = "greenhouse:synthetic:123";
const target = "https://boards.greenhouse.io/synthetic/jobs/123";
const initial = {
  job_application: { first_name: "Synthetic", answers: { a: true, b: "Private answer" } },
  fingerprint: "synthetic-fingerprint",
  "g-recaptcha-enterprise-token": "opaque-token",
};
describe("Greenhouse frozen challenge protocol", () => {
  test("application hash is canonical and independent of user verification envelope", () => {
    const before = challengeRequest(JSON.stringify(initial), identity, target);
    const after = challengeRequest(
      JSON.stringify({
        fingerprint: initial.fingerprint,
        security_code: "12345678",
        job_application: { answers: { b: "Private answer", a: true }, first_name: "Synthetic" },
      }),
      identity,
      target,
    );
    expect(after.applicationPayloadHash).toBe(before.applicationPayloadHash);
    expect(after.fingerprintHash).toBe(before.fingerprintHash);
    expect(after.requestBodyHash).not.toBe(before.requestBodyHash);
    expect(before.requestBodyHash).toBe(
      createHash("sha256").update(JSON.stringify(initial)).digest("hex"),
    );
  });
  test("canonical application hashes use codepoint order including nested mixed-case keys", () => {
    const request = { ...initial, job_application: { a: "lower", Z: "upper", _a: { z: 1, A: 2 } } };
    const expected = createHash("sha256")
      .update(JSON.stringify({ Z: "upper", _a: { A: 2, z: 1 }, a: "lower" }))
      .digest("hex");
    expect(challengeRequest(JSON.stringify(request), identity, target).applicationPayloadHash).toBe(
      expected,
    );
  });
  test("field values, booleans and attachment URLs are part of the frozen application", () => {
    const before = challengeRequest(JSON.stringify(initial), identity, target);
    for (const job_application of [
      { ...initial.job_application, first_name: "Changed" },
      { ...initial.job_application, answers: { a: false, b: "Private answer" } },
      { ...initial.job_application, resume_url: "https://example.test/new.pdf" },
    ])
      expect(
        challengeRequest(JSON.stringify({ ...initial, job_application }), identity, target)
          .applicationPayloadHash,
      ).not.toBe(before.applicationPayloadHash);
  });
  test("unknown envelope fields and alternate targets never gain forwarding authority", () => {
    for (const url of [
      `${target}?x=1`,
      `${target}/`,
      target.replace("123", "124"),
      target.replace("https:", "http:"),
      target.replace("boards.greenhouse.io", "job-boards.greenhouse.io"),
    ])
      expect(() => challengeRequest(JSON.stringify(initial), identity, url)).toThrow("destination");
    expect(() =>
      challengeRequest(JSON.stringify({ ...initial, request_token: "unknown" }), identity, target),
    ).toThrow("protocol");
    expect(() => challengeRequest("{}", identity, target)).toThrow("protocol");
  });
  test("only recognized response.code errors classify a challenge without disclosing recipient", () => {
    for (const code of [
      "captcha-failed",
      "captcha-retry",
      "invalid-security-code",
      "expired-security-code",
      "security-code-error",
    ] as const)
      expect(
        challengeResponse(
          JSON.stringify({
            code,
            message: "private detail",
            security_code_recipient: "private@example.test",
          }),
        ),
      ).toEqual({ code, hasRecipient: true });
    expect(() => challengeResponse('{"error":"captcha-failed"}')).toThrow("recognized");
    expect(() => challengeResponse('{"code":"success"}')).toThrow("recognized");
    const base = {
      schemaVersion: 1,
      kind: "greenhouse_post_submit_challenge",
      attemptId: crypto.randomUUID(),
      manifestHash: "a".repeat(64),
      targetUrl: target,
      capturedAt: new Date().toISOString(),
      requestBodyHash: "b".repeat(64),
      applicationPayloadHash: "c".repeat(64),
      responseBody: '{"code":"captcha-failed"}',
    };
    for (const responseStatus of [200, 302, 500])
      expect(challengeResponseArtifactSchema.safeParse({ ...base, responseStatus }).success).toBe(
        false,
      );
    expect(
      challengeResponseArtifactSchema.safeParse({ ...base, responseStatus: 422 }).success,
    ).toBe(true);
  });
  test("public response strips private transport fields", () => {
    const result = personalChallengeResponseSchema.parse({
      attemptId: crypto.randomUUID(),
      transport: {
        manifestHash: "a".repeat(64),
        applicationPayloadHash: "b".repeat(64),
        requestBodyHash: "c".repeat(64),
        evidenceHash: "d".repeat(64),
        targetUrl: target,
        requestBody: JSON.stringify(initial),
        fingerprintHash: "e".repeat(64),
      },
      challenge: null,
    });
    expect(JSON.stringify(result)).not.toContain("Synthetic");
    expect(JSON.stringify(result)).not.toContain("fingerprint");
  });
});
