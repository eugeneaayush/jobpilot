import type { IntakeResult } from "./intake";
import {
  evidenceConflictId,
  evidenceValueHash,
  type ResumeResolutionOverlay,
  resolveResumeEvidence,
  resumeResolutionOverlaySchema,
} from "./resume-evidence";
import { describe, expect, test } from "bun:test";

type Conflict = IntakeResult["manifest"]["conflicts"][number];
const sourceSha256 = "a".repeat(64);
const auditSha256 = "b".repeat(64);
const citation = {
  source: "Synthetic user assertion",
  locator: "test-assertion-1",
  quote: "Use the corrected synthetic score without percentile.",
};
const auditCitation = {
  source: "private/synthetic-audit.json",
  locator: "/items/0",
  quote: "These entries are the same claims in a different order.",
  sourceSha256: auditSha256,
};
function difference(values: unknown[], pointer = "/education/0/details/0"): Conflict {
  return {
    kind: "source_difference",
    source: "synthetic-comparison.json",
    pointer,
    message: "Comparison requires review",
    values,
  };
}
const scoreConflict = difference([
  "Synthetic score 610 (unverified percentile)",
  "Synthetic score 640",
]);
const scoreDocument = {
  education: [{ details: ["Synthetic score 610 (unverified percentile)"] }],
  experience: [
    {
      company: "Example Company",
      title: "Analyst",
      start: "2040",
      bullets: ["Managed a synthetic project"],
    },
  ],
};
test("optional undefined object fields are absent JSON values without mutating input", () => {
  const document = { basics: { name: "Synthetic Person", linkedin: undefined } };
  const result = resolveResumeEvidence({ document, sourceSha256, conflicts: [] });
  expect(result.document).toEqual({ basics: { name: "Synthetic Person" } });
  expect(Object.hasOwn(document.basics, "linkedin")).toBe(true);
  expect(() =>
    resolveResumeEvidence({ document: { list: [undefined] }, sourceSha256, conflicts: [] }),
  ).toThrow();
});
function scoreOverlay(): ResumeResolutionOverlay {
  return {
    sourceSha256,
    edits: [
      {
        id: "explicit-score-correction",
        pointer: "/education/0/details/0",
        operation: "replace",
        expectedValue: scoreDocument.education[0]?.details[0],
        value: "Synthetic score 640",
        citation,
        resolvesConflictIds: [evidenceConflictId(scoreConflict)],
      },
    ],
  };
}

describe("source-preserving resume resolution overlays", () => {
  test("automatically recognizes only conservative typography and preserves complete comparisons", () => {
    const typography = difference(["Example Company, Research", "Example Company — Research"]);
    const number = difference(["20–25 projects", "20 25 projects"]);
    const metadata: Conflict = {
      kind: "unmapped_fields",
      source: "synthetic.json",
      message: "Unmapped fields",
      values: ["/layout"],
    };
    const result = resolveResumeEvidence({
      document: scoreDocument,
      sourceSha256,
      conflicts: [typography, number, metadata],
    });
    expect(result.conflicts[0]?.status).toBe("resolved");
    expect(result.conflicts[1]?.status).toBe("unresolved");
    expect(result.conflicts[2]?.status).toBe("unresolved");
    expect(result.conflicts.map((review) => review.conflict)).toEqual([
      typography,
      number,
      metadata,
    ]);
    expect(result.sourceEvidenceReady).toBe(false);
  });
  test("a cited correction changes only the derived document and removes an unsupported percentile", () => {
    const before = structuredClone(scoreDocument);
    const conflictBefore = structuredClone(scoreConflict);
    const result = resolveResumeEvidence({
      document: scoreDocument,
      sourceSha256,
      conflicts: [scoreConflict],
      overlay: scoreOverlay(),
    });
    expect(result.document).toEqual({
      ...scoreDocument,
      education: [{ details: ["Synthetic score 640"] }],
    });
    expect(scoreDocument).toEqual(before);
    expect(scoreConflict).toEqual(conflictBefore);
    expect(result.originalDocument).toEqual(before);
    expect(result.conflicts[0]?.conflict.values).toEqual(scoreConflict.values);
    expect(result.conflicts[0]?.citation).toEqual(citation);
    expect(result.provenance.changes[0]?.before).toContain("unverified percentile");
    expect(result.provenance.changes[0]?.after).toBe("Synthetic score 640");
    expect(result.provenance.originalDocumentSha256).toBe(evidenceValueHash(before));
    expect(result.provenance.derivedDocumentSha256).toBe(evidenceValueHash(result.document));
    expect(result.sourceEvidenceReady).toBe(true);
    expect("renderReviewed" in result).toBe(false);
  });
  test("correcting one claim cannot dismiss other substantive conflicts", () => {
    const dates = difference(["2040-02", "2040-08"], "/experience/0/end");
    const result = resolveResumeEvidence({
      document: scoreDocument,
      sourceSha256,
      conflicts: [scoreConflict, dates],
      overlay: scoreOverlay(),
    });
    expect(result.unresolvedConflicts.map((review) => review.id)).toEqual([
      evidenceConflictId(dates),
    ]);
    expect(result.sourceEvidenceReady).toBe(false);
  });
  test("structural classifications bind a specific conflict and frozen audit citation", () => {
    const conflict = difference(["Project A", "Project B"], "/experience/0/bullets/0");
    const result = resolveResumeEvidence({
      document: scoreDocument,
      sourceSha256,
      conflicts: [conflict],
      overlay: {
        sourceSha256,
        classifications: [
          {
            id: "reviewed-reordering",
            conflictId: evidenceConflictId(conflict),
            classification: "structural",
            rationale:
              "The semantic comparison maps the original bullet to another index; no claim changes.",
            citation: auditCitation,
          },
        ],
      },
    });
    expect(result.sourceEvidenceReady).toBe(true);
    expect(result.document).toEqual(scoreDocument);
    expect(result.provenance.classifications[0]?.citation.sourceSha256).toBe(auditSha256);
    expect(
      resumeResolutionOverlaySchema.safeParse({
        sourceSha256,
        classifications: [
          {
            id: "missing-frozen-hash",
            conflictId: evidenceConflictId(conflict),
            classification: "structural",
            rationale: "Review",
            citation,
          },
        ],
      }).success,
    ).toBe(false);
  });
  test("explicitly classified unsupported claims still block source readiness", () => {
    const result = resolveResumeEvidence({
      document: scoreDocument,
      sourceSha256,
      conflicts: [scoreConflict],
      overlay: {
        sourceSha256,
        classifications: [
          {
            id: "needs-proof",
            conflictId: evidenceConflictId(scoreConflict),
            classification: "unsupported",
            rationale: "No source supports this claim yet.",
            citation: auditCitation,
          },
        ],
      },
    });
    expect(result.sourceEvidenceReady).toBe(false);
    expect(result.conflicts[0]?.classification).toBe("unsupported");
  });
  test("source, expected value and expected hash mismatches fail before changing input", () => {
    const before = structuredClone(scoreDocument);
    expect(() =>
      resolveResumeEvidence({
        document: scoreDocument,
        sourceSha256: "c".repeat(64),
        conflicts: [scoreConflict],
        overlay: scoreOverlay(),
      }),
    ).toThrow("source hash mismatch");
    const wrongValue = scoreOverlay();
    if (wrongValue.edits?.[0]) wrongValue.edits[0].expectedValue = "Different prior value";
    expect(() =>
      resolveResumeEvidence({
        document: scoreDocument,
        sourceSha256,
        conflicts: [scoreConflict],
        overlay: wrongValue,
      }),
    ).toThrow("prior value mismatch");
    const wrongHash = scoreOverlay();
    if (wrongHash.edits?.[0]) wrongHash.edits[0].expectedValueSha256 = "d".repeat(64);
    expect(() =>
      resolveResumeEvidence({
        document: scoreDocument,
        sourceSha256,
        conflicts: [scoreConflict],
        overlay: wrongHash,
      }),
    ).toThrow("prior hash mismatch");
    expect(scoreDocument).toEqual(before);
  });
  test("hash-only expectations and no-op retain decisions carry provenance", () => {
    const value = "Synthetic retained amount";
    const conflict = difference([value, "Old amount"], "/amount");
    const result = resolveResumeEvidence({
      document: { amount: value },
      sourceSha256,
      conflicts: [conflict],
      overlay: {
        sourceSha256,
        edits: [
          {
            id: "explicit-retain",
            pointer: "/amount",
            operation: "replace",
            expectedValueSha256: evidenceValueHash(value),
            value,
            citation,
            resolvesConflictIds: [evidenceConflictId(conflict)],
          },
        ],
      },
    });
    expect(result.document).toEqual({ amount: value });
    expect(result.sourceEvidenceReady).toBe(true);
    expect(result.provenance.changes[0]?.afterSha256).toBe(
      result.provenance.changes[0]?.beforeSha256,
    );
  });
  test("array omissions use original indices and preserve original values in provenance", () => {
    const original = { details: ["first", "omit", "third", "fourth"] };
    const result = resolveResumeEvidence({
      document: original,
      sourceSha256,
      conflicts: [],
      overlay: {
        sourceSha256,
        edits: [
          {
            id: "remove-unsupported",
            pointer: "/details/1",
            operation: "omit",
            expectedValue: "omit",
            citation,
          },
          {
            id: "correct-later",
            pointer: "/details/3",
            operation: "replace",
            expectedValue: "fourth",
            value: "corrected fourth",
            citation,
          },
        ],
      },
    });
    expect(result.document).toEqual({ details: ["first", "third", "corrected fourth"] });
    expect(original.details).toEqual(["first", "omit", "third", "fourth"]);
    expect(result.provenance.changes[0]?.afterSha256).toBeNull();
  });
  test("escaped pointers are supported and unsafe or overlapping edits are rejected", () => {
    const result = resolveResumeEvidence({
      document: { "a/b": { "~key": "old" } },
      sourceSha256,
      conflicts: [],
      overlay: {
        sourceSha256,
        edits: [
          {
            id: "escaped",
            pointer: "/a~1b/~0key",
            operation: "replace",
            expectedValue: "old",
            value: "new",
            citation,
          },
        ],
      },
    });
    expect(result.document).toEqual({ "a/b": { "~key": "new" } });
    expect(() =>
      resolveResumeEvidence({
        document: {},
        sourceSha256,
        conflicts: [],
        overlay: {
          sourceSha256,
          edits: [
            {
              id: "unsafe",
              pointer: "/__proto__/polluted",
              operation: "replace",
              expectedValue: null,
              value: true,
              citation,
            },
          ],
        },
      }),
    ).toThrow("Unsafe");
    expect(() =>
      resolveResumeEvidence({
        document: { a: { b: "old" } },
        sourceSha256,
        conflicts: [],
        overlay: {
          sourceSha256,
          edits: [
            {
              id: "parent",
              pointer: "/a",
              operation: "omit",
              expectedValue: { b: "old" },
              citation,
            },
            {
              id: "child",
              pointer: "/a/b",
              operation: "replace",
              expectedValue: "old",
              value: "new",
              citation,
            },
          ],
        },
      }),
    ).toThrow("Overlapping");
  });
  test("changed conflict inventories and duplicate resolution IDs cannot reuse stale decisions", () => {
    expect(() =>
      resolveResumeEvidence({
        document: scoreDocument,
        sourceSha256,
        conflicts: [{ ...scoreConflict, message: "Updated source discrepancy" }],
        overlay: scoreOverlay(),
      }),
    ).toThrow("unknown or changed conflict");
    const duplicate = scoreOverlay();
    if (duplicate.edits?.[0])
      duplicate.edits.push({
        ...duplicate.edits[0],
        pointer: "/experience/0/title",
        expectedValue: "Analyst",
        value: "Analyst",
        resolvesConflictIds: [],
      });
    expect(() =>
      resolveResumeEvidence({
        document: scoreDocument,
        sourceSha256,
        conflicts: [scoreConflict],
        overlay: duplicate,
      }),
    ).toThrow("Duplicate resolution ID");
  });
});
