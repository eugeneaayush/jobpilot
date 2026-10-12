import type { PersonalDocumentVerification } from "@jobpilot/contracts/personal-local-tools";
import { documentPipelineInputs } from "./pipeline-config";
import { assertVerificationScope } from "./verification-policy";
import { describe, expect, test } from "bun:test";

const expected = {
  artifactSha256: "a".repeat(64),
  renderer: "cbs-letter-times",
  requiredText: ["Synthetic Person", "synthetic@example.test"],
  supportedTerms: ["C++", "PE"],
  maxPages: 1 as const,
};
const complete = (): PersonalDocumentVerification => ({
  artifactSha256: expected.artifactSha256,
  renderer: expected.renderer,
  verifierVersion: "1",
  verifierConfigHash: documentPipelineInputs("cbs-letter-times").verifierConfigHash,
  status: "passed",
  pageCount: 1,
  extractedCharacters: 100,
  checks: [
    "artifact_hash",
    "page_limit",
    "text_layer",
    "glyphs",
    "renderer_margins",
    "layout_bounds",
    "required_text_0",
    "required_text_1",
    "supported_term_0",
    "supported_term_1",
  ].map((code) => ({ code, status: "passed", message: "Synthetic check" })),
});

describe("request-bound document verification", () => {
  test("accepts complete checks for the exact artifact and request", () => {
    expect(() => assertVerificationScope(complete(), expected)).not.toThrow();
  });
  test("rejects old or changed verifier dependency/configuration evidence", () => {
    for (const verifierConfigHash of [undefined, "0".repeat(64)]) {
      expect(() =>
        assertVerificationScope({ ...complete(), verifierConfigHash }, expected),
      ).toThrow("scope mismatch");
    }
  });
  for (const missing of ["required_text_1", "supported_term_0", "renderer_margins"]) {
    test(`rejects a passed response omitting ${missing}`, () => {
      const report = complete();
      report.checks = report.checks.filter((check) => check.code !== missing);
      expect(() => assertVerificationScope(report, expected)).toThrow("requested checks");
    });
  }
  test("rejects a passed two-page response when only one page was authorized", () => {
    expect(() => assertVerificationScope({ ...complete(), pageCount: 2 }, expected)).toThrow();
  });
  test("rejects duplicate, out-of-range, failed, and unknown check results", () => {
    for (const modification of ["required_text_0", "required_text_9", "unknown"]) {
      const report = complete();
      report.checks[7].code = modification;
      expect(() => assertVerificationScope(report, expected)).toThrow();
    }
    const report = complete();
    report.checks[7].status = "failed";
    expect(() => assertVerificationScope(report, expected)).toThrow();
  });
  test("requires matching bytes and renderer even for failed responses", () => {
    expect(() =>
      assertVerificationScope({ ...complete(), artifactSha256: "b".repeat(64) }, expected),
    ).toThrow();
    expect(() =>
      assertVerificationScope({ ...complete(), renderer: "other", status: "failed" }, expected),
    ).toThrow();
  });
  test("preserves incomplete failed or unavailable reports as holds", () => {
    for (const status of ["failed", "unavailable"] as const)
      expect(() =>
        assertVerificationScope({ ...complete(), status, checks: [], pageCount: null }, expected),
      ).not.toThrow();
  });
});
