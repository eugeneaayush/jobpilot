import type { PersonalDocumentVerification } from "@jobpilot/contracts/personal-local-tools";
import { verifierPipelineMatches } from "./pipeline-config";

/** A well-formed response must also cover the exact checks requested for these bytes. */
export function assertVerificationScope(
  report: PersonalDocumentVerification,
  expected: {
    artifactSha256: string;
    renderer: string;
    requiredText: string[];
    supportedTerms: string[];
    maxPages: 1 | 2;
  },
): void {
  if (
    report.artifactSha256 !== expected.artifactSha256 ||
    report.renderer !== expected.renderer ||
    !verifierPipelineMatches(report, expected.renderer)
  )
    throw new Error("Document verification scope mismatch");
  if (report.status !== "passed") return;
  const codes = [
    "artifact_hash",
    "page_limit",
    "text_layer",
    "glyphs",
    "renderer_margins",
    "layout_bounds",
    ...expected.requiredText.map((_, index) => `required_text_${index}`),
    ...expected.supportedTerms.map((_, index) => `supported_term_${index}`),
  ];
  if (
    report.pageCount === null ||
    report.pageCount < 1 ||
    report.pageCount > expected.maxPages ||
    report.extractedCharacters < 60 ||
    report.checks.length !== codes.length ||
    report.checks.some((check) => check.status !== "passed") ||
    codes.some((code) => report.checks.filter((check) => check.code === code).length !== 1)
  )
    throw new Error("Document verification omitted or contradicted requested checks");
}
