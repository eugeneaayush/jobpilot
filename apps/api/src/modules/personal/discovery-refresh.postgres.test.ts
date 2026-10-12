import path from "node:path";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { PersonalApprovalService } from "./approval.service";
import { PersonalDiscoveryService, saveDiscoveredRecord } from "./discovery.service";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalRecoveryService } from "./recovery.service";
import { recoveryContext } from "./recovery-policy";
import { jsonValue, objectValue, savePrivate } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("discovery refresh preserves concurrent records", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("preserves append-only approval history while changed posting evidence invalidates readiness", async () => {
    const f = await personalFixture(db);
    const { record } = await f.record("42", "https://example.test/jobs/42");
    const history = objectValue(record.details).applicationApprovals;
    expect(Array.isArray(history) && history.length > 0).toBe(true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(
        "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs?content=true",
      );
      return Response.json({
        meta: { total: 1 },
        jobs: [
          {
            id: 42,
            title: "Updated MBA internship",
            company_name: "Synthetic Employer",
            absolute_url: record.url,
            location: { name: "New York, NY" },
            content:
              "<p>This paid internship recruits MBA students. The internship runs from June 2027 to August 2027. Updated responsibilities include research for our clients.</p>",
          },
        ],
      });
    }) as typeof fetch;
    try {
      const service = new PersonalDiscoveryService(db.prisma, {
        resumeData: async () => ({ data: EMPTY_RESUME_DATA, evidence: f.resume }),
      } as unknown as PersonalService);
      expect((await service.discover(f.user.id, { boardToken: "synthetic" })).status).toBe(
        "complete",
      );
      const updated = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { id: record.id },
      });
      expect(objectValue(updated.details).applicationApprovals).toEqual(history);
      expect(objectValue(updated.details).preview).toBeUndefined();
      const review = await new PersonalApprovalService(db.prisma, db.service).get(
        f.user.id,
        record.id,
        "session",
      );
      expect(review.approval?.status).toBe("stale");
      expect(review.blockers.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a current manual eligibility decision and unanswered screening question through routine discovery, then invalidates changed requirements", async () => {
    const f = await personalFixture(db);
    const quote = "Candidates must have financial analysis experience.";
    const changedQuote = "Candidates must be a citizen of Canada.";
    const missingQuestion = "Which interview dates can you attend?";
    let evidence = await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: {
        details: {
          conflicts: [],
          manifest: { leaves: [{ pointer: "/experience/0/summary", value: "Financial analysis" }] },
        },
      },
    });
    const discovery = new PersonalDiscoveryService(db.prisma, {
      resumeData: async () => ({ data: EMPTY_RESUME_DATA, evidence }),
    } as unknown as PersonalService);
    const recovery = new PersonalRecoveryService(db.prisma);
    let sourceClause = quote;
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(
        "https://boards-api.greenhouse.io/v1/boards/syntheticrefresh/jobs?content=true",
      );
      requests++;
      return Response.json({
        jobs: [
          {
            id: 42,
            title: "Synthetic MBA internship",
            absolute_url: "https://example.test/jobs/42",
            content: `<p>${sourceClause}</p><p>This is a paid internship. The internship runs from June 2027 to August 2027. You will work with our team and conduct research for our clients.</p>`,
            company_name: "Synthetic Employer",
            location: { name: "New York, NY" },
          },
        ],
        meta: { total: 1 },
      });
    }) as typeof fetch;
    try {
      expect((await discovery.discover(f.user.id, { boardToken: "syntheticrefresh" })).status).toBe(
        "complete",
      );
      const record = await db.prisma.personalRecord.findUniqueOrThrow({
        where: {
          userId_identity: { userId: f.user.id, identity: "greenhouse:syntheticrefresh:42" },
        },
      });
      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: {
          details: jsonValue({
            ...objectValue(record.details),
            missingAnswers: [
              ...(objectValue(record.details).missingAnswers as string[]),
              missingQuestion,
            ],
          }),
        },
      });
      const before = await recovery.get(f.user.id, record.id);
      expect(
        before.requirements.filter((requirement) => requirement.status === "unknown"),
      ).toHaveLength(1);
      expect(before.requirements[0]?.status).toBe("unknown");
      const adjudicated = await recovery.adjudicate(f.user.id, record.id, {
        expectedUpdatedAt: before.updatedAt.toISOString(),
        context: before.context,
        decisions: [
          {
            requirementId: before.requirements[0]!.id,
            status: "satisfied",
            rationale: "The exact synthetic resume leaf establishes financial analysis experience",
            sourceQuote: quote,
            citation: {
              kind: "resume",
              pointer: "/experience/0/summary",
              value: "Financial analysis",
            },
          },
        ],
      });
      expect(adjudicated.eligibility).toBe("eligible");
      const adjudicatedRecord = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { id: record.id },
      });
      const decision = objectValue(adjudicatedRecord.details).eligibilityAdjudication;
      expect(objectValue(adjudicatedRecord.details).missingAnswers).toEqual([missingQuestion]);

      await db.prisma.personalSource.updateMany({
        where: { userId: f.user.id },
        data: { nextEligibleAt: new Date(0) },
      });
      await discovery.discover(f.user.id, { boardToken: "syntheticrefresh" });
      const unchanged = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { id: record.id },
      });
      const unchangedDetails = objectValue(unchanged.details);
      expect(unchanged.state).toBe("eligible");
      expect(objectValue(unchangedDetails.eligibility).decision).toBe("eligible");
      expect(unchangedDetails.eligibilityAdjudication).toEqual(decision);
      expect(unchangedDetails.missingAnswers).toEqual([missingQuestion]);
      expect(objectValue(unchangedDetails.evaluation).requirements).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "unknown", evidence: quote })]),
      );
      expect((await recovery.get(f.user.id, record.id)).requirements[0]?.status).toBe("satisfied");

      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: {
          details: jsonValue({
            ...unchangedDetails,
            eligibilityContext: { ...objectValue(unchangedDetails.eligibilityContext), version: 1 },
          }),
        },
      });
      await db.prisma.personalSource.updateMany({
        where: { userId: f.user.id },
        data: { nextEligibleAt: new Date(0) },
      });
      await discovery.discover(f.user.id, { boardToken: "syntheticrefresh" });
      const refreshed = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { id: record.id },
      });
      const refreshedDetails = objectValue(refreshed.details);
      expect(refreshedDetails.eligibilityAdjudication).toEqual(decision);
      expect(refreshedDetails.eligibilityAdjudicationHistory).toEqual([decision]);
      expect(refreshedDetails.missingAnswers).toEqual([missingQuestion]);
      expect(objectValue(refreshedDetails.eligibilityContext).version).toBeGreaterThan(1);
      expect((await recovery.get(f.user.id, record.id)).eligibility).toBe("eligible");

      const originalEvidence = evidence;
      const settingsPath = path.join(db.root, "settings", `${f.user.id}.json`);
      for (const mutation of ["settings", "resume", "raw requirements", "history only"]) {
        const base = structuredClone(refreshedDetails);
        base.eligibilityContext = { ...objectValue(base.eligibilityContext), version: 1 };
        await savePrivate(settingsPath, f.settings);
        evidence = await db.prisma.personalResumeEvidence.update({
          where: { id: originalEvidence.id },
          data: { details: jsonValue(originalEvidence.details) },
        });
        if (mutation === "settings")
          await savePrivate(settingsPath, { ...f.settings, yearsExperience: 7 });
        if (mutation === "resume")
          evidence = await db.prisma.personalResumeEvidence.update({
            where: { id: originalEvidence.id },
            data: { details: { ...objectValue(originalEvidence.details), revised: true } },
          });
        if (mutation === "raw requirements") {
          base.evaluation = {
            ...objectValue(base.evaluation),
            requirements: [
              ...(objectValue(base.evaluation).requirements as unknown[]),
              {
                requirement: "Synthetic prior rule",
                evidence: quote,
                status: "unknown",
                candidateEvidence: null,
              },
            ],
          };
          base.eligibilityAdjudication = {
            ...objectValue(decision),
            context: recoveryContext(
              { ...refreshed, details: jsonValue(base) as typeof refreshed.details },
              f.settings,
              evidence,
            ),
          };
        }
        if (mutation === "history only") delete base.eligibilityAdjudication;
        await db.prisma.personalRecord.update({
          where: { id: record.id },
          data: { details: jsonValue(base) },
        });
        await db.prisma.personalSource.updateMany({
          where: { userId: f.user.id },
          data: { nextEligibleAt: new Date(0) },
        });
        await discovery.discover(f.user.id, { boardToken: "syntheticrefresh" });
        const invalidated = await db.prisma.personalRecord.findUniqueOrThrow({
          where: { id: record.id },
        });
        const invalidatedDetails = objectValue(invalidated.details);
        expect(invalidatedDetails.eligibilityAdjudication).toBeUndefined();
        expect(invalidatedDetails.eligibilityAdjudicationHistory).toEqual([decision]);
        expect(objectValue(invalidatedDetails.eligibility).decision).toBe("unknown");
        expect((await recovery.get(f.user.id, record.id)).requirements[0]?.status).toBe("unknown");
      }
      await savePrivate(settingsPath, f.settings);
      evidence = await db.prisma.personalResumeEvidence.update({
        where: { id: originalEvidence.id },
        data: { details: jsonValue(originalEvidence.details) },
      });
      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: { details: jsonValue(refreshedDetails) },
      });

      sourceClause = changedQuote;
      await db.prisma.personalSource.updateMany({
        where: { userId: f.user.id },
        data: { nextEligibleAt: new Date(0) },
      });
      await discovery.discover(f.user.id, { boardToken: "syntheticrefresh" });
      const changed = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { id: record.id },
      });
      const changedDetails = objectValue(changed.details);
      const reviewedAgain = await recovery.get(f.user.id, record.id);
      expect(changed.state).toBe("discovered");
      expect(objectValue(changedDetails.eligibility).decision).toBe("unknown");
      expect(reviewedAgain.eligibility).toBe("unknown");
      expect(reviewedAgain.context.postingHash).not.toBe(adjudicated.context.postingHash);
      expect(reviewedAgain.context.requirementsHash).not.toBe(adjudicated.context.requirementsHash);
      expect(reviewedAgain.requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "unknown", evidence: changedQuote }),
        ]),
      );
      expect(changedDetails.missingAnswers).toContain(reviewedAgain.requirements[0]!.requirement);
      expect(changedDetails.eligibilityAdjudicationHistory).toEqual([decision]);
      expect(requests).toBe(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not overwrite a newer screening-answer snapshot with a stale source refresh", async () => {
    const f = await personalFixture(db);
    const { record } = await f.record();
    const newSnapshot = { answers: [{ key: "answer", value: "Explicit user answer" }] };
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: { ...objectValue(record.details), screeningAnswerSnapshots: [newSnapshot] },
        updatedAt: new Date(record.updatedAt.getTime() + 1000),
      },
    });
    const saved = await saveDiscoveredRecord(
      db.prisma,
      record,
      {
        userId: f.user.id,
        identity: record.identity,
        title: "Refresh",
        company: record.company,
        url: record.url,
        track: record.track,
      },
      { details: { stale: true } },
    );
    expect(saved).toBe(false);
    const current = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(current.details).toMatchObject({ screeningAnswerSnapshots: [newSnapshot] });
  });

  it.each([
    "preparation",
    "tailoring",
    "prepared attempt",
  ])("preserves a pre-existing active %s during changed-source discovery", async (kind) => {
    const f = await personalFixture(db);
    const { record: initial } = await f.record();
    if (kind === "prepared attempt") {
      await db.prisma.personalAttempt.create({
        data: {
          recordId: initial.id,
          userId: f.user.id,
          campaignId: f.campaign.campaignId,
          mode: "offline",
          state: "prepared",
          manifest: { synthetic: true },
          manifestHash: db.hash,
          leaseOwner: "synthetic",
          leaseExpiresAt: new Date(0),
          attemptNo: 1,
          policyDay: "2026-01-01",
        },
      });
    } else {
      await db.prisma.personalRecord.update({
        where: { id: initial.id },
        data: {
          details: jsonValue({
            ...objectValue(initial.details),
            [kind]: {
              status: "running",
              leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
              claimId: crypto.randomUUID(),
            },
          }),
        },
      });
    }
    const record = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: initial.id } });
    const attempts = await db.prisma.personalAttempt.findMany({ where: { recordId: record.id } });
    expect(
      await saveDiscoveredRecord(
        db.prisma,
        record,
        {
          userId: f.user.id,
          identity: record.identity,
          title: "New source title",
          company: record.company,
          url: record.url,
          track: record.track,
        },
        { title: "New source title", details: { overwritten: true } },
      ),
    ).toBe(false);
    expect(await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).toEqual(
      record,
    );
    expect(await db.prisma.personalAttempt.findMany({ where: { recordId: record.id } })).toEqual(
      attempts,
    );
  });

  it("does not replace a record created concurrently or a submission-bound record", async () => {
    const f = await personalFixture(db);
    const { record } = await f.record();
    const create = {
      userId: f.user.id,
      identity: record.identity,
      title: "Stale create",
      company: record.company,
      url: record.url,
      track: record.track,
    };
    expect(await saveDiscoveredRecord(db.prisma, undefined, create, { title: "Overwrite" })).toBe(
      false,
    );
    const applying = await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: { state: "applying" },
    });
    expect(await saveDiscoveredRecord(db.prisma, applying, create, { state: "eligible" })).toBe(
      false,
    );
    expect(
      (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).state,
    ).toBe("applying");
  });
});
