import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import type { PersonalEligibilityAdjudicationInput } from "@jobpilot/contracts/personal-recovery";
import type {
  PersonalAttempt,
  PersonalRecord,
  PersonalResumeEvidence,
  PrismaClient,
} from "@/generated/prisma/client";
import { PersonalRecoveryService } from "./recovery.service";
import { recoveryContext, recoveryRequirements } from "./recovery-policy";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { jsonValue, objectValue } from "./runtime";
import { expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({
  recruitingAvailability: {
    partTimeNow: true,
    partTimeMaxHours: 20,
    partTimeLocations: ["NYC", "US remote"],
    internshipStartMonth: "2027-05",
    internshipEndMonth: "2027-09",
    permanentStartMonth: "2028-05",
    paidOnly: true,
    englishSufficientOnly: true,
    employerSupportedInternational: true,
    unrestrictedTravelRelocation: true,
  },
  workAuthorization: true,
  workAuthorizationCountries: ["US"],
  citizenship: "US",
});
const description =
  "This paid internship recruits MBA students. The internship runs from June 2027 to August 2027. You will work with our team and conduct research for our clients.";

function fixture(descriptionText = description, location = "New York, NY", approved = settings) {
  const userId = crypto.randomUUID();
  const evidence = {
    id: crypto.randomUUID(),
    sourceHash: "a".repeat(64),
    details: { conflicts: [] },
  } as unknown as PersonalResumeEvidence;
  const record = {
    id: crypto.randomUUID(),
    userId,
    identity: "greenhouse:synthetic:1",
    track: "mba_internship",
    title: "MBA internship",
    company: "Synthetic",
    url: "https://example.test/job",
    state: "discovered",
    updatedAt: new Date("2026-09-16T12:00:00Z"),
    details: {
      posting: { descriptionText, location },
      eligibility: { decision: "unknown" },
      evaluation: {
        requirements: assessRecruitingConstraints(
          { title: "MBA internship", descriptionText, location },
          settings,
        ).requirements,
      },
      preview: { readiness: "draft" },
    },
  } as unknown as PersonalRecord;
  const attempts: PersonalAttempt[] = [];
  const runId = crypto.randomUUID();
  let writes = 0;
  const context = () => recoveryContext(record, approved, evidence);
  const tx = {
    $queryRaw: async () => [{ id: userId }],
    personalRecord: {
      updateMany: async ({
        data,
      }: {
        data: { state: PersonalRecord["state"]; details: PersonalRecord["details"] };
      }) => {
        writes++;
        Object.assign(record, data, { updatedAt: new Date(record.updatedAt.getTime() + 1) });
        return { count: 1 };
      },
    },
    campaign: {
      findFirst: async () => ({
        config: {
          personal: {
            name: "Synthetic",
            scheduler: "personal-campaign-v1",
            enabled: false,
            policyVersion: "test",
            mode: "offline",
            approvalPolicy: "per-application-v1",
            sources: { boardTokens: ["synthetic"] },
            tracks: ["mba_internship"],
            fitThreshold: 0,
            dailyCap: 1,
            maxApplications: 1,
            timezone: "America/New_York",
            authorization: {
              runId,
              authorizedAt: new Date().toISOString(),
              ...context(),
              snapshotHash: "a",
              settings: approved,
            },
          },
        },
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (db: typeof tx) => Promise<unknown>) => work(tx),
  };
  const service = new PersonalRecoveryService(prisma as unknown as PrismaClient);
  // Only storage is replaced; the real adjudication and graduate policy execute together.
  Object.assign(service, {
    load: async () => ({ record, settings: approved, evidence, attempts, context: context() }),
  });
  function decision(pointer: string, value: string | boolean) {
    const unknown = recoveryRequirements(record.details).find((r) => r.status === "unknown")!;
    return {
      requirementId: unknown.id,
      status: "satisfied",
      rationale: "Exact synthetic source review",
      sourceQuote: unknown.evidence,
      citation: { kind: "settings", pointer, value },
    } satisfies PersonalEligibilityAdjudicationInput["decisions"][number];
  }
  const input = (decisions: PersonalEligibilityAdjudicationInput["decisions"]) => ({
    expectedUpdatedAt: record.updatedAt.toISOString(),
    context: context(),
    decisions,
  });
  return {
    service,
    userId,
    record,
    attempts,
    runId,
    context,
    decision,
    input,
    writes: () => writes,
  };
}

for (const [name, text, location, pointer, value] of [
  [
    "pay preference",
    description.replace("paid internship", "internship"),
    "New York, NY",
    "/recruitingAvailability/paidOnly",
    true,
  ],
  [
    "language preference",
    `${description} Mandarin fluency is required.`,
    "New York, NY",
    "/recruitingAvailability/englishSufficientOnly",
    true,
  ],
  [
    "citizenship for employer sponsorship",
    `${description} The role is based in London, United Kingdom.`,
    "London, United Kingdom",
    "/citizenship",
    "US",
  ],
  [
    "irrelevant availability fact",
    description.replace("June 2027 to August 2027", "Summer 2027"),
    "New York, NY",
    "/citizenship",
    "US",
  ],
] as const) {
  test(`recovery cannot persist eligible using ${name}`, async () => {
    const f = fixture(text, location);
    const before = JSON.stringify(f.record);
    await expect(
      f.service.adjudicate(f.userId, f.record.id, f.input([f.decision(pointer, value)])),
    ).rejects.toThrow("relevant source evidence");
    expect(f.writes()).toBe(0);
    expect(JSON.stringify(f.record)).toBe(before);
  });
}

test("recovery uses proposed current adjudication for a relevant availability citation", async () => {
  const f = fixture(description.replace("June 2027 to August 2027", "Summer 2027"));
  const reviewed = await f.service.adjudicate(
    f.userId,
    f.record.id,
    f.input([f.decision("/recruitingAvailability/internshipStartMonth", "2027-05")]),
  );
  expect(reviewed.eligibility).toBe("eligible");
  expect(f.record.state).toBe("eligible");
  expect(objectValue(f.record.details).preview).toBeUndefined();
  expect(objectValue(f.record.details).eligibilityAdjudicationHistory).toHaveLength(1);
});

test("missing approved availability cannot persist eligible even with satisfied stored requirements", async () => {
  const f = fixture(description, "New York, NY", personalSettingsSchema.parse({}));
  await expect(f.service.adjudicate(f.userId, f.record.id, f.input([]))).rejects.toThrow(
    "Approved recruiting availability",
  );
  expect(f.writes()).toBe(0);
});

test("an undergraduate role cannot acquire an eligible recovery state", async () => {
  const f = fixture(
    description.replace("MBA students", "undergraduate students pursuing a bachelor's degree"),
  );
  f.record.title = "Undergraduate internship";
  await expect(f.service.adjudicate(f.userId, f.record.id, f.input([]))).rejects.toThrow(
    "Undergraduate entry-level roles are excluded",
  );
  expect(f.writes()).toBe(0);
});

test("an unresolved partial adjudication remains saveable and unknown", async () => {
  const f = fixture(description.replace("paid internship", "internship"));
  const unknown = f.decision("/recruitingAvailability/paidOnly", true);
  const reviewed = await f.service.adjudicate(
    f.userId,
    f.record.id,
    f.input([{ ...unknown, status: "unknown" }]),
  );
  expect(reviewed.eligibility).toBe("unknown");
  expect(f.record.state).toBe("discovered");
  expect(f.writes()).toBe(1);
});

test("legacy invalid eligible adjudication is exposed as held and cannot requeue eligible", async () => {
  const f = fixture(description.replace("paid internship", "internship"));
  f.record.details = jsonValue({
    ...objectValue(f.record.details),
    eligibility: { decision: "eligible" },
    eligibilityAdjudication: {
      context: f.context(),
      decisions: [f.decision("/recruitingAvailability/paidOnly", true)],
    },
  }) as PersonalRecord["details"];
  f.record.state = "failed";
  f.attempts.push({
    id: crypto.randomUUID(),
    campaignId: crypto.randomUUID(),
    state: "failed",
    mode: "offline",
    submitAt: null,
    receipt: { reason: "Synthetic rendering failure" },
  } as unknown as PersonalAttempt);
  const current = await f.service.get(f.userId, f.record.id);
  expect(current.eligibility).toBe("unknown");
  expect(current.recovery.allowed).toBe(false);
  expect(current.recovery.blockers).toContain(
    "Recruiting constraint requires relevant source evidence: Paid compensation",
  );
  await expect(
    f.service.recover(f.userId, f.record.id, {
      expectedUpdatedAt: current.updatedAt.toISOString(),
      context: current.context,
      attemptId: f.attempts[0]!.id,
      campaignRunId: f.runId,
      reason: "Retry synthetic rendering after source review",
      proof: { kind: "retry_failure" },
    }),
  ).rejects.toThrow("relevant source evidence");
  expect(f.writes()).toBe(0);
});

test("recovery requeues an unresolved role with unknown persisted eligibility", async () => {
  const f = fixture(description.replace("paid internship", "internship"));
  f.record.details = {
    ...objectValue(f.record.details),
    eligibility: { decision: "eligible" },
  } as PersonalRecord["details"];
  f.record.state = "failed";
  f.attempts.push({
    id: crypto.randomUUID(),
    campaignId: crypto.randomUUID(),
    state: "failed",
    mode: "offline",
    submitAt: null,
    receipt: { reason: "Synthetic rendering failure" },
  } as unknown as PersonalAttempt);
  const current = await f.service.get(f.userId, f.record.id);
  const result = await f.service.recover(f.userId, f.record.id, {
    expectedUpdatedAt: current.updatedAt.toISOString(),
    context: current.context,
    attemptId: f.attempts[0]!.id,
    campaignRunId: f.runId,
    reason: "Requeue unresolved evidence for review",
    proof: { kind: "retry_failure" },
  });
  expect(result.eligibility).toBe("unknown");
  expect(String(f.record.state)).toBe("discovered");
  expect(objectValue(f.record.details).eligibility).toMatchObject({ decision: "unknown" });
});
