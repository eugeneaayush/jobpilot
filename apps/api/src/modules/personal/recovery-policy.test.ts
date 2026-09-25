import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { personalEligibilityAdjudicationSchema } from "@jobpilot/contracts/personal-recovery";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import {
  activeRecoveryRevision,
  adjudicatedRequirements,
  overallEligibility,
  recoveryContext,
  recoveryRequirements,
  validateEligibilityDecision,
} from "./recovery-policy";
import { describe, expect, it } from "bun:test";

const settings = personalSettingsSchema.parse({});
const quote = "Candidates must have financial analysis experience.";
const record = {
  identity: "greenhouse:synthetic:1",
  title: "Analyst",
  company: "Synthetic",
  details: {
    posting: { descriptionText: quote },
    evaluation: {
      requirements: [
        { requirement: "Experience", evidence: quote, status: "unknown", candidateEvidence: null },
      ],
    },
  },
} as unknown as PersonalRecord;
const evidence = {
  id: crypto.randomUUID(),
  sourceHash: "a".repeat(64),
  details: {
    manifest: {
      leaves: [
        { pointer: "/experience/0/summary", value: "Financial analysis" },
        { pointer: "/facts/authorized", value: true },
      ],
    },
    conflicts: ["Unresolved conflict"],
  },
} as unknown as PersonalResumeEvidence;
const context = recoveryContext(record, settings, evidence);
const id = recoveryRequirements(record.details)[0]!.id;
const decision = {
  requirementId: id,
  status: "satisfied" as const,
  rationale: "Exact prior financial analysis responsibility",
  sourceQuote: quote,
  citation: {
    kind: "resume" as const,
    pointer: "/experience/0/summary",
    value: "Financial analysis",
  },
};

describe("source-grounded eligibility recovery policy", () => {
  it("requires exact source clause and stored fact without transformations", () => {
    expect(() =>
      validateEligibilityDecision(decision, record, settings, evidence, context),
    ).not.toThrow();
    expect(() =>
      validateEligibilityDecision(
        { ...decision, sourceQuote: "Experience preferred" },
        record,
        settings,
        evidence,
        context,
      ),
    ).toThrow("exact stored");
    expect(() =>
      validateEligibilityDecision(
        { ...decision, citation: { ...decision.citation, value: "Senior financial analysis" } },
        record,
        settings,
        evidence,
        context,
      ),
    ).toThrow("exactly match");
    expect(() =>
      validateEligibilityDecision(
        { ...decision, citation: undefined },
        record,
        settings,
        evidence,
        context,
      ),
    ).toThrow("requires");
  });
  it("preserves booleans and rejects string coercion", () => {
    const citation = { kind: "resume" as const, pointer: "/facts/authorized", value: true };
    expect(() =>
      validateEligibilityDecision({ ...decision, citation }, record, settings, evidence, context),
    ).not.toThrow();
    expect(() =>
      validateEligibilityDecision(
        { ...decision, citation: { ...citation, value: "true" } },
        record,
        settings,
        evidence,
        context,
      ),
    ).toThrow();
  });
  it("rejects arbitrary eligible flags and duplicate decisions at the API boundary", () => {
    const input = { expectedUpdatedAt: new Date().toISOString(), context, decisions: [decision] };
    expect(personalEligibilityAdjudicationSchema.safeParse(input).success).toBe(true);
    expect(
      personalEligibilityAdjudicationSchema.safeParse({ ...input, eligible: true }).success,
    ).toBe(false);
    expect(
      personalEligibilityAdjudicationSchema.safeParse({ ...input, decisions: [decision, decision] })
        .success,
    ).toBe(false);
  });
  it("freezes decisions to posting/settings/evidence and retains original requirements", () => {
    const details = {
      ...(record.details as object),
      eligibilityAdjudication: { context, decisions: [decision] },
    };
    expect(overallEligibility(adjudicatedRequirements(details, context))).toBe("eligible");
    expect(
      overallEligibility(
        adjudicatedRequirements(details, { ...context, evidenceHash: "b".repeat(64) }),
      ),
    ).toBe("unknown");
    expect(overallEligibility(recoveryRequirements(record.details))).toBe("unknown");
    expect(overallEligibility([])).toBe("unknown");
    expect(
      overallEligibility([{ ...recoveryRequirements(record.details)[0]!, status: "violated" }]),
    ).toBe("ineligible");
    expect(evidence.details).toMatchObject({ conflicts: ["Unresolved conflict"] });
  });
  it("accepts recovery revisions only for the exact campaign run and source context", () => {
    const details = {
      recoveryTicket: {
        campaignId: "campaign",
        campaignRunId: "run",
        context,
        revision: "revision",
      },
    };
    expect(activeRecoveryRevision(details, "campaign", "run", context)).toBe("revision");
    expect(activeRecoveryRevision(details, "campaign", "another", context)).toBeNull();
    expect(
      activeRecoveryRevision(details, "campaign", "run", {
        ...context,
        postingHash: "c".repeat(64),
      }),
    ).toBeNull();
  });
});

it("eligibility citations cannot reuse original facts removed by a resolution overlay", () => {
  const resolved = {
    ...evidence,
    details: {
      ...(evidence.details as object),
      resolution: { document: { experience: [{ summary: "Corrected analysis responsibility" }] } },
    },
  };
  expect(() =>
    validateEligibilityDecision(
      decision,
      record,
      settings,
      resolved,
      recoveryContext(record, settings, resolved),
    ),
  ).toThrow("overridden or omitted");
  expect(() =>
    validateEligibilityDecision(
      {
        ...decision,
        citation: {
          kind: "resume",
          pointer: "/resolved/experience/0/summary",
          value: "Corrected analysis responsibility",
        },
      },
      record,
      settings,
      resolved,
      recoveryContext(record, settings, resolved),
    ),
  ).not.toThrow();
});
