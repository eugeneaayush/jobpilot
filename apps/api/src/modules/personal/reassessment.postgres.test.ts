import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalReassessmentService } from "./reassessment.service";
import { jsonValue, objectValue, readSettings } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("offline reassessment transaction", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("preserves a confirmed attempt and receipt even if the record was erroneously left eligible", async () => {
    const f = await personalFixture(db);
    const { record } = await f.record();
    const attempt = await db.prisma.personalAttempt.create({
      data: {
        recordId: record.id,
        userId: f.user.id,
        campaignId: f.campaign.campaignId,
        mode: "submit",
        state: "submitted",
        manifest: { prior: "immutable" },
        manifestHash: db.hash,
        leaseOwner: "synthetic",
        leaseExpiresAt: new Date(0),
        attemptNo: 1,
        policyDay: "2026-01-01",
        submitAt: new Date(0),
        receipt: { outcome: "confirmed", reference: "synthetic-confirmation" },
      },
    });
    const service = new PersonalReassessmentService(db.prisma, {
      settings: readSettings,
      resumeData: async () => ({ data: EMPTY_RESUME_DATA, evidence: f.resume }),
    } as unknown as PersonalService);
    expect(await service.reassess(f.user.id)).toEqual({ evaluated: 0, skipped: 1 });
    expect(await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).toEqual(
      record,
    );
    expect(
      await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toEqual(attempt);
  });

  it("archives preparation references while leaving source snapshots and foreign records unchanged", async () => {
    const f = await personalFixture(db);
    const other = await personalFixture(db);
    const foreign = (await other.record()).record;
    const initial = (await f.record()).record;
    const source = {
      descriptionText: "Candidates must be undergraduate students graduating in 2028.",
      location: "New York",
    };
    const record = await db.prisma.personalRecord.update({
      where: { id: initial.id },
      data: {
        title: "Business Analyst Intern",
        state: "prepared",
        details: jsonValue({
          ...objectValue(initial.details),
          posting: source,
          manifestPath: "synthetic-old.json",
          document: { path: "synthetic-old.pdf" },
          screeningAnswerSnapshots: [{ snapshotHash: "synthetic" }],
        }),
      },
    });
    const service = new PersonalReassessmentService(db.prisma, {
      settings: readSettings,
      resumeData: async () => ({ data: EMPTY_RESUME_DATA, evidence: f.resume }),
    } as unknown as PersonalService);
    expect(await service.reassess(f.user.id)).toEqual({ evaluated: 1, skipped: 0 });
    const updated = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(updated.state).toBe("discovered");
    expect(updated.details).toMatchObject({
      posting: source,
      evaluation: { seniority: { classification: "undergraduate_entry" } },
      screeningAnswerSnapshots: [{ snapshotHash: "synthetic" }],
      reassessmentHistory: [
        { manifestPath: "synthetic-old.json", document: { path: "synthetic-old.pdf" } },
      ],
    });
    expect(objectValue(updated.details).preview).toBeUndefined();
    expect(objectValue(updated.details).manifestPath).toBeUndefined();
    expect(await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(
      foreign,
    );
    expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(0);
  });
});
