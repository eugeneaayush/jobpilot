import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import type { PersonalRecord } from "@/generated/prisma/client";
import { eligibilityContext, eligibilityFreshness } from "./eligibility-freshness";
import { personalRecordDto } from "./personal.mapper";
import { jsonValue, objectValue } from "./runtime";
import { describe, expect, test } from "bun:test";

function fixture() {
  const sources = {
    settings: personalSettingsSchema.parse({ mbaEnrolled: true, graduationYear: 2028 }),
    evidence: {
      id: crypto.randomUUID(),
      sourceHash: "a".repeat(64),
      details: { conflicts: [] as string[] },
    },
  };
  const record: PersonalRecord = {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    campaignId: null,
    jobId: null,
    identity: "cbs:synthetic:1",
    title: "MBA internship",
    company: "Synthetic",
    requisitionId: "1",
    url: "https://example.test/jobs/1",
    state: "eligible",
    track: "mba_internship",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    details: {
      posting: { contentHash: "b".repeat(64), descriptionText: "MBA students required." },
      eligibility: { decision: "eligible", reasons: ["Synthetic reviewed requirement"] },
      evaluation: {
        requirements: [
          {
            requirement: "MBA enrollment",
            status: "satisfied",
            evidence: "MBA students required.",
            candidateEvidence: "Enrolled",
          },
        ],
      },
    },
  };
  record.details = jsonValue({
    ...objectValue(record.details),
    eligibilityContext: eligibilityContext(record, sources),
  }) as PersonalRecord["details"];
  return { record, sources };
}

describe("source-bound eligibility freshness", () => {
  test("exact current context is current without changing the record", () => {
    const { record, sources } = fixture();
    const before = structuredClone(record);
    expect(eligibilityFreshness(record, sources)).toEqual({ status: "current", reason: null });
    expect(record).toEqual(before);
  });
  test.each([
    "settings",
    "evidence",
    "resume ID",
    "source hash",
    "description",
    "title",
    "requirements",
    "evaluator version 1",
    "evaluator version 2",
    "evaluator version 3",
    "evaluator version 4",
    "missing stamp",
  ])("%s drift is explicitly stale", (change) => {
    const { record, sources } = fixture();
    if (change === "settings") sources.settings.workAuthorization = true;
    if (change === "evidence") sources.evidence.details.conflicts.push("Synthetic conflict");
    if (change === "resume ID") sources.evidence.id = crypto.randomUUID();
    if (change === "source hash") sources.evidence.sourceHash = "c".repeat(64);
    if (change === "description")
      objectValue(objectValue(record.details).posting).descriptionText =
        "Changed despite retained upstream hash";
    if (change === "title") record.title = "Undergraduate internship";
    if (change === "requirements")
      objectValue(objectValue(record.details).evaluation).requirements = [];
    if (change.startsWith("evaluator version"))
      objectValue(objectValue(record.details).eligibilityContext).version = Number(change.at(-1));
    if (change === "missing stamp") delete objectValue(record.details).eligibilityContext;
    const dto = personalRecordDto(record, sources);
    expect(dto.eligibilityFreshness?.status).toBe("stale");
    expect(dto.eligibility.decision).toBe("unknown");
    expect(dto.eligibility.reasons.some((reason) => reason.includes("needs refresh"))).toBe(true);
    expect(objectValue(objectValue(record.details).eligibility).decision).toBe("eligible");
  });
  test("missing source access is unknown, never reported as verified current", () => {
    const { record } = fixture();
    const dto = personalRecordDto(record);
    expect(dto.eligibilityFreshness?.status).toBe("unknown");
    expect(dto.eligibility.decision).toBe("unknown");
    expect(dto.eligibility.reasons).toContain("Current eligibility sources are unavailable");
  });
  test("time alone invalidates eligibility only when the source deadline expires", () => {
    const { record, sources } = fixture();
    const deadline = Date.parse("2027-01-01T00:00:00Z");
    objectValue(objectValue(record.details).posting).deadline = new Date(deadline).toISOString();
    objectValue(record.details).eligibilityContext = eligibilityContext(
      record,
      sources,
      deadline - 60000,
    );
    expect(eligibilityFreshness(record, sources, deadline - 1000).status).toBe("current");
    expect(eligibilityFreshness(record, sources, deadline).status).toBe("current");
    expect(eligibilityFreshness(record, sources, deadline + 1).status).toBe("stale");
    objectValue(record.details).eligibilityContext = eligibilityContext(
      record,
      sources,
      deadline + 1,
    );
    expect(eligibilityFreshness(record, sources, deadline + 60000).status).toBe("current");
  });

  test("a textual date-only deadline invalidates freshness at both uncertainty and expiry boundaries", () => {
    const { record, sources } = fixture();
    const posting = objectValue(objectValue(record.details).posting);
    posting.deadline = null;
    posting.descriptionText =
      "This role will remain open until November 6, 2026 and we will review all applications at that time.";
    const start = Date.parse("2026-11-05T10:00:00Z");
    const end = Date.parse("2026-11-07T12:00:00Z");
    objectValue(record.details).eligibilityContext = eligibilityContext(
      record,
      sources,
      start - 60000,
    );
    expect(eligibilityFreshness(record, sources, start - 1).status).toBe("current");
    expect(eligibilityFreshness(record, sources, start).status).toBe("stale");
    objectValue(record.details).eligibilityContext = eligibilityContext(record, sources, start);
    expect(eligibilityFreshness(record, sources, end - 1).status).toBe("current");
    expect(eligibilityFreshness(record, sources, end).status).toBe("stale");
    objectValue(record.details).eligibilityContext = eligibilityContext(record, sources, end);
    expect(eligibilityFreshness(record, sources, end + 60000).status).toBe("current");
    expect(objectValue(objectValue(record.details).eligibilityContext).version).toBe(5);
  });
});
