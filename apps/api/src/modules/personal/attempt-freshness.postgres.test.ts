import type { PersonalReceiptEvidence } from "@jobpilot/contracts/personal-attempt";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { jsonValue, objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("attempt eligibility freshness at the submit boundary", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  async function oldContext(recordId: string, version: number | null) {
    const record = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: recordId } });
    const details = objectValue(record.details);
    if (version === null) delete details.eligibilityContext;
    else objectValue(details.eligibilityContext).version = version;
    return db.prisma.personalRecord.update({
      where: { id: recordId },
      data: { details: jsonValue(details) },
    });
  }

  for (const version of [1, 2, 3, null]) {
    for (const stage of ["start", "prepare", "beginSubmit"] as const) {
      test(`${stage} holds ${version === null ? "missing" : `version ${version}`} eligibility without changing active work`, async () => {
        const f = await personalFixture(db);
        const { record, input } = await f.record();
        const attempt = stage === "start" ? null : await db.service.start(f.user.id, input);
        if (attempt && stage === "beginSubmit")
          await db.service.prepare(f.user.id, attempt.id, attempt);
        const before = await oldContext(record.id, version);
        const attempts = await db.prisma.personalAttempt.findMany({ where: { userId: f.user.id } });
        const reservations = await db.prisma.personalReservation.findMany({
          where: { userId: f.user.id },
        });
        const action =
          stage === "start"
            ? db.service.start(f.user.id, input)
            : db.service[stage](f.user.id, attempt!.id, attempt!);
        await expect(action).rejects.toThrow("Eligibility needs refresh");
        expect(
          await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } }),
        ).toEqual(before);
        expect(await db.prisma.personalAttempt.findMany({ where: { userId: f.user.id } })).toEqual(
          attempts,
        );
        expect(
          await db.prisma.personalReservation.findMany({ where: { userId: f.user.id } }),
        ).toEqual(reservations);
      });
    }
  }

  test.each([
    "receipt",
    "reconcile",
  ] as const)("current context may submit; %s still records confirmation after an evaluator upgrade", async (method) => {
    const f = await personalFixture(db);
    const { record, input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    const submitting = await db.service.beginSubmit(f.user.id, attempt.id, attempt);
    expect(submitting.state).toBe("submitting");
    expect(submitting.submitAt).not.toBeNull();
    await oldContext(record.id, 1);
    const evidence: PersonalReceiptEvidence = {
      outcome: "submitted",
      kind: "confirmation_page",
      artifactPath: f.artifactPath,
      sha256: db.hash,
      sourceUrl: record.url,
      capturedAt: new Date().toISOString(),
      details: "Synthetic employer confirmation only; no employer contacted",
      manifestHash: attempt.manifestHash,
    };
    const result =
      method === "receipt"
        ? await db.service.receipt(f.user.id, attempt.id, attempt, evidence)
        : await db.service.reconcile(f.user.id, attempt.id, evidence);
    expect(result.state).toBe("submitted");
    expect(result.submitAt).toEqual(submitting.submitAt);
    expect(objectValue(result.receipt).manifestHash).toBe(attempt.manifestHash);
    expect(
      objectValue(
        objectValue(
          (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).details,
        ).eligibilityContext,
      ).version,
    ).toBe(1);
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
  });
});
