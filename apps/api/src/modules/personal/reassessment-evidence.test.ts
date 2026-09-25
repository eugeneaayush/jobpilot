import "reflect-metadata";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import type { PersonalEligibilityAdjudicationInput } from "@jobpilot/contracts/personal-recovery";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import type { PersonalRecord, Prisma, PrismaClient } from "@/generated/prisma/client";
import type { PersonalService } from "./personal.service";
import { PersonalReassessmentService } from "./reassessment.service";
import {
  recoveryContext,
  recoveryRequirements,
  validateEligibilityDecision,
} from "./recovery-policy";
import { jsonValue, objectValue } from "./runtime";
import { describe, expect, test } from "bun:test";

async function fixture() {
  const settings = personalSettingsSchema.parse({
    mbaEnrolled: true,
    graduationYear: 2028,
    workAuthorization: true,
    workAuthorizationCountries: ["US"],
  });
  const data = {
    ...EMPTY_RESUME_DATA,
    education: [{ school: "Synthetic University", degree: "MBA", end: "May 2028", details: [] }],
  };
  const evidence = {
    id: crypto.randomUUID(),
    sourceHash: "a".repeat(64),
    details: { resolution: { document: data } },
  };
  const row: PersonalRecord = {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    campaignId: null,
    jobId: null,
    identity: "greenhouse:synthetic:1",
    title: "MBA Intern",
    company: "Synthetic Employer",
    url: "https://example.test/jobs/1",
    requisitionId: "1",
    state: "discovered",
    track: "mba_internship",
    createdAt: new Date(0),
    updatedAt: new Date(1),
    details: {
      posting: {
        descriptionText:
          "MBA candidates must graduate in May 2028. Candidates must be authorized to work in the US.",
        location: "New York, NY",
        deadline: null,
      },
    },
  };
  let activeAttempt = false;
  const prisma = {
    personalResumeEvidence: { findFirst: async () => evidence },
    personalRecord: {
      count: async () => 1,
      findMany: async () => [structuredClone(row)],
      findFirst: async () => row,
      updateMany: async ({ data: update }: { data: Partial<PersonalRecord> }) => {
        Object.assign(row, update, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
        return { count: 1 };
      },
    },
    personalAttempt: { findFirst: async () => (activeAttempt ? { id: "active" } : null) },
    $queryRaw: async () => [{ id: row.userId }],
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  const service = new PersonalReassessmentService(
    prisma as unknown as PrismaClient,
    {
      settings: async () => settings,
      resumeData: async () => ({ data, evidence }),
    } as unknown as PersonalService,
  );
  await service.reassess(row.userId);
  const context = recoveryContext(row, settings, evidence);
  const requirements = recoveryRequirements(row.details);
  const unknown = requirements.filter((item) => item.status === "unknown");
  expect(unknown.map((item) => item.requirement)).toEqual(["Graduation cohort"]);
  const decisions: PersonalEligibilityAdjudicationInput["decisions"] = unknown.map((item) => ({
    requirementId: item.id,
    sourceQuote: item.evidence,
    status: "satisfied",
    rationale: "The source resume explicitly confirms graduation in May 2028.",
    citation: { kind: "resume", pointer: "/resolved/education/0/end", value: "May 2028" },
  }));
  for (const decision of decisions)
    validateEligibilityDecision(decision, row, settings, evidence, context);
  const adjudication = { id: crypto.randomUUID(), context, decisions };
  const ticket = {
    revision: crypto.randomUUID(),
    context,
    fromAttemptId: crypto.randomUUID(),
    campaignId: crypto.randomUUID(),
    campaignRunId: crypto.randomUUID(),
    proof: { kind: "eligibility", adjudicationId: adjudication.id },
  };
  row.details = jsonValue({
    ...objectValue(row.details),
    eligibilityAdjudication: adjudication,
    eligibilityAdjudicationHistory: [adjudication],
    recoveryTicket: ticket,
    recoveryHistory: [ticket],
    preview: { readiness: "ready" },
    document: { path: "synthetic.pdf" },
    manifestPath: "synthetic.json",
    missingAnswers: ["Graduation cohort", "Interview availability"],
  }) as Prisma.JsonValue;
  return {
    row,
    settings,
    evidence,
    service,
    adjudication,
    ticket,
    setActiveAttempt: () => {
      activeAttempt = true;
    },
  };
}

describe("reassessment preserves only current source-grounded review", () => {
  test("keeps unchanged adjudication and recovery while requiring fresh preparation", async () => {
    const f = await fixture();
    expect(await f.service.reassess(f.row.userId)).toEqual({ evaluated: 1, skipped: 0 });
    const details = objectValue(f.row.details);
    expect(details.eligibilityAdjudication).toEqual(f.adjudication);
    expect(details.recoveryTicket).toEqual(f.ticket);
    expect(details.eligibility).toMatchObject({ decision: "eligible" });
    expect(f.row.state).toBe("eligible");
    expect(details.missingAnswers).toEqual(["Interview availability"]);
    expect(
      recoveryRequirements(details).find((item) => item.requirement === "Graduation cohort")
        ?.status,
    ).toBe("unknown");
    for (const key of ["preview", "document", "manifestPath"]) expect(details[key]).toBeUndefined();
    expect((details.reassessmentHistory as unknown[]).at(-1)).toMatchObject({
      eligibilityAdjudication: f.adjudication,
      recoveryTicket: f.ticket,
    });
  });

  test.each([
    "posting",
    "settings",
    "resume ID",
    "source hash",
    "evidence",
    "identity",
    "requirements",
  ])("invalidates review and recovery after a material %s change", async (change) => {
    const f = await fixture();
    if (change === "posting")
      objectValue(objectValue(f.row.details).posting).descriptionText += " New posting details.";
    if (change === "settings") f.settings.requiresSponsorship = false;
    if (change === "resume ID") f.evidence.id = crypto.randomUUID();
    if (change === "source hash") f.evidence.sourceHash = "b".repeat(64);
    if (change === "evidence")
      f.evidence.details.resolution.document.education[0]!.end = "June 2028";
    if (change === "identity") f.row.identity = "greenhouse:synthetic:2";
    if (change === "requirements") {
      const evaluation = objectValue(objectValue(f.row.details).evaluation);
      evaluation.requirements = [
        ...(evaluation.requirements as unknown[]),
        {
          requirement: "Retired parser requirement",
          evidence: "Former rule",
          status: "unknown",
          candidateEvidence: null,
        },
      ];
      const previous = recoveryContext(f.row, f.settings, f.evidence);
      objectValue(objectValue(f.row.details).eligibilityAdjudication).context = previous;
      objectValue(objectValue(f.row.details).recoveryTicket).context = previous;
    }
    await f.service.reassess(f.row.userId);
    const details = objectValue(f.row.details);
    expect(details.eligibilityAdjudication).toBeUndefined();
    expect(details.recoveryTicket).toBeUndefined();
    expect(details.eligibility).toMatchObject({ decision: "unknown" });
    expect(details.missingAnswers).toContain("Graduation cohort");
    expect(details.eligibilityAdjudicationHistory).toHaveLength(1);
    expect(details.recoveryHistory).toHaveLength(1);
  });

  test("checks the adjudication and recovery contexts independently", async () => {
    const f = await fixture();
    objectValue(objectValue(f.row.details).recoveryTicket).context = {
      ...f.ticket.context,
      settingsHash: "c".repeat(64),
    };
    await f.service.reassess(f.row.userId);
    expect(objectValue(f.row.details).eligibilityAdjudication).toEqual(f.adjudication);
    expect(objectValue(f.row.details).recoveryTicket).toBeUndefined();
    expect(objectValue(f.row.details).eligibility).toMatchObject({ decision: "eligible" });
  });

  test("does not infer a sponsorship answer from posting silence", async () => {
    const f = await fixture();
    await f.service.reassess(f.row.userId);
    expect(f.settings.requiresSponsorship).toBeNull();
    expect(
      recoveryRequirements(f.row.details).some((item) => /sponsor/i.test(item.requirement)),
    ).toBe(false);
  });

  test("preserves the whole record when an active attempt owns it", async () => {
    const f = await fixture();
    f.setActiveAttempt();
    const before = structuredClone(f.row);
    expect(await f.service.reassess(f.row.userId)).toEqual({ evaluated: 0, skipped: 1 });
    expect(f.row).toEqual(before);
  });
});
