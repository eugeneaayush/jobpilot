import { readFileSync } from "node:fs";
import path from "node:path";
import type { PersonalDocumentEdits } from "@jobpilot/contracts/personal-yaml";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import {
  applyReviewedProposal,
  buildTailoringInput,
  type ReviewedProposal,
  tailoringHash,
} from "./tailoring/proposal";
import { applyImportedStructure, localToolSourceHash } from "./yaml.structure";
import { describe, expect, test } from "bun:test";

function fixture() {
  const base = resumeDataSchema.parse({
    basics: { name: "Alex Example", email: "alex@example.com" },
    experience: [
      {
        company: "Original Co",
        title: "Analyst",
        start: "2022",
        bullets: ["Analyzed markets", "Prepared research"],
      },
      {
        company: "Second Co",
        title: "Analyst",
        start: "2020",
        bullets: ["Built financial models"],
      },
    ],
    projects: [{ name: "Public research", bullets: ["Studied public markets"] }],
    skills: [{ group: "Tools", items: ["Python", "SQL"] }],
  });
  const input = buildTailoringInput(base, {
    sourceDigest: "a".repeat(64),
    maxPages: 1,
    job: {
      identity: "example-role",
      company: "Example",
      title: "Analyst",
      description: "A complete investment research analyst posting",
      postingContentHash: "b".repeat(64),
    },
  });
  const fact = input.facts.find((item) => item.pointer === "/experience/0/bullets/0")!;
  const proposal = {
    version: 1 as const,
    inputHash: input.inputHash,
    rewrites: [
      {
        id: "rewrite-0",
        targetFactId: fact.id,
        text: "Conducted market analysis",
        citations: [{ factId: fact.id, quoteSha256: fact.quoteSha256 }],
      },
    ],
    essayClaims: [],
  };
  const reviewed: ReviewedProposal = {
    input,
    proposal,
    review: {
      sourceDigest: input.sourceDigest,
      inputHash: input.inputHash,
      proposalHash: tailoringHash(proposal),
      reviewer: "independent-reviewer",
      reviewedAt: new Date().toISOString(),
      independent: true,
      claims: [
        {
          claimId: "rewrite-0",
          decision: "supported",
          factIds: [fact.id],
          rationale: "Rephrase retains the source action",
        },
      ],
    },
  };
  const accepted = applyReviewedProposal(base, reviewed);
  const edits: PersonalDocumentEdits = {
    version: 1,
    baseDataHash: input.baseDataHash,
    sourceSha256: localToolSourceHash(base),
    sourceDigest: input.sourceDigest,
    proposalHash: tailoringHash(proposal),
    requiresIndependentReview: true,
    operations: [],
  };
  return { base, reviewed, accepted, edits };
}

function apply(operations: PersonalDocumentEdits["operations"]) {
  const { base, reviewed, accepted, edits } = fixture();
  return applyImportedStructure(base, accepted, { ...edits, operations }, reviewed);
}

describe("reviewed YAML structure", () => {
  test("reorders source entries after their reviewed rewrites", () => {
    const result = apply([{ kind: "reorder", path: "/experience", before: [0, 1], after: [1, 0] }]);
    expect(result.experience[0].company).toBe("Second Co");
    expect(result.experience[1].bullets[0]).toBe("Conducted market analysis");
    expect(result.experience[1].end).toBeUndefined();
  });
  test("applies child selection with original indices before parent order", () => {
    const result = apply([
      { kind: "reorder", path: "/experience", before: [0, 1], after: [1, 0] },
      {
        kind: "cut",
        path: "/experience/0/bullets",
        before: ["Analyzed markets", "Prepared research"],
        after: ["Analyzed markets"],
      },
    ]);
    expect(result.experience[1].bullets).toEqual(["Conducted market analysis"]);
  });
  test.each(
    (
      [
        [{ kind: "cut", path: "/experience", before: [0, 1], after: [] }],
        [{ kind: "reorder", path: "/experience", before: [0, 1], after: [0, 0] }],
        [{ kind: "reorder", path: "/experience", before: [0, 1], after: [2, 0] }],
        [{ kind: "reorder", path: "/experience", before: [1, 0], after: [0, 1] }],
        [{ kind: "cut", path: "/experience/0/bullets", before: ["Changed source"], after: [] }],
        [
          {
            kind: "cut",
            path: "/skills/0/items",
            before: ["Python", "SQL"],
            after: ["InventedTechnology"],
          },
        ],
        [{ kind: "cut", path: "/basics/name", before: ["Alex Example"], after: [] }],
        [{ kind: "cut", path: "/__proto__/polluted", before: [], after: [] }],
        [{ kind: "reorder", path: "/experience", before: [0, 1], after: [1] }],
        [{ kind: "cut", path: "/experience", before: [0, 1], after: [1, 0] }],
      ] as PersonalDocumentEdits["operations"][]
    ).map((operations) => ({ operations })),
  )("rejects unsupported selection %j", ({ operations }) => {
    expect(() => apply(operations)).toThrow();
  });
  test("rejects editing an omitted employer", () => {
    expect(() =>
      apply([
        { kind: "cut", path: "/experience", before: [0, 1], after: [1] },
        {
          kind: "cut",
          path: "/experience/0/bullets",
          before: ["Analyzed markets", "Prepared research"],
          after: ["Analyzed markets"],
        },
      ]),
    ).toThrow("removed");
  });
  test("rejects duplicated operations", () => {
    const operation = { kind: "cut" as const, path: "/experience", before: [0, 1], after: [0] };
    expect(() => apply([operation, operation])).toThrow("Duplicate");
  });
  test("requires independent review even for zero rewrites", () => {
    const { base, accepted, edits, reviewed } = fixture();
    delete reviewed.review;
    expect(() => applyImportedStructure(base, accepted, edits, reviewed)).toThrow("independent");
  });
  test("rejects source, proposal and artifact drift", () => {
    const { base, accepted, edits, reviewed } = fixture();
    expect(() =>
      applyImportedStructure(base, accepted, { ...edits, sourceSha256: "f".repeat(64) }, reviewed),
    ).toThrow("stale");
    accepted.experience[0].company = "Fake Employer";
    expect(() => applyImportedStructure(base, accepted, edits, reviewed)).toThrow("exact reviewed");
  });
  test("source hash agrees with shared Python fixture", () => {
    const file = path.resolve(
      import.meta.dir,
      "../../../../../services/local-tools/tests/fixtures/protocol.json",
    );
    const shared = JSON.parse(readFileSync(file, "utf8"));
    expect(localToolSourceHash(shared.source)).toBe(shared.sourceSha256);
  });
});
