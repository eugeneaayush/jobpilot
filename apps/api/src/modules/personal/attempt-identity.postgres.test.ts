import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersonalAttemptStartInput } from "@jobpilot/contracts/personal-attempt";
import type { PersonalRecord } from "@/generated/prisma/client";
import { eligibilityContext } from "./eligibility-freshness";
import { manifestHash } from "./persistence-policy";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
  refreshPersonalFixtureApproval,
} from "./persistence-test-fixtures";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("employer job submission identity", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function withJob(
    record: PersonalRecord,
    internalJobId: string,
    input?: PersonalAttemptStartInput,
  ) {
    const posting = { ...objectValue(objectValue(record.details).posting), internalJobId };
    const questions = JSON.stringify({
      id: record.requisitionId,
      internal_job_id: Number(internalJobId),
      questions: [],
    });
    const questionHash = sha256(questions);
    const questionPath = join(db.root, "storage", record.userId, `${questionHash}.json`);
    await writeFile(questionPath, questions, { mode: 0o600 });
    const oldInventory = objectValue(objectValue(record.details).attachmentRequirements);
    const attachmentRequirements = {
      ...oldInventory,
      identity: record.identity,
      postingContentHash: manifestHash(posting),
      source: {
        ...objectValue(oldInventory.source),
        path: questionPath,
        sha256: questionHash,
        capturedAt: new Date().toISOString(),
      },
    };
    if (input) {
      input.manifest = {
        ...input.manifest,
        attachmentRequirements: JSON.parse(JSON.stringify(attachmentRequirements)),
        postingContentHash: manifestHash(posting),
      };
    }
    return db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...objectValue(record.details),
          posting,
          attachmentRequirements,
          previewAttachments: { attachmentRequirements, attachments: [] },
        }),
      },
    });
  }

  it("serializes distinct posts for one employer job while allowing distinct jobs", async () => {
    const f = await personalFixture(db, "offline", 10);
    const first = await f.record();
    const second = await f.record();
    await withJob(first.record, "456", first.input);
    await withJob(second.record, "456", second.input);
    const results = await Promise.allSettled([
      db.service.start(f.user.id, first.input),
      db.service.start(f.user.id, second.input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reservation = await db.prisma.personalReservation.findFirstOrThrow({
      where: { userId: f.user.id },
    });
    expect(reservation.identity).toBe("greenhouse:synthetic:job:456");
    const winner = await db.prisma.personalAttempt.findUniqueOrThrow({
      where: { id: reservation.attemptId },
    });
    const frozen = objectValue(winner.manifest);
    expect(frozen.submissionIdentity).toBe(reservation.identity);
    expect(frozen.identity).toBe(
      [first, second].find((row) => row.record.id === winner.recordId)?.record.identity,
    );
    const third = await f.record();
    await withJob(third.record, "457", third.input);
    await expect(db.service.start(f.user.id, third.input)).resolves.toMatchObject({
      recordId: third.record.id,
    });
  });

  it("preserves a historical native-post submission reservation through another post", async () => {
    const f = await personalFixture(db, "offline", 10);
    const historical = await f.record();
    await db.prisma.personalRecord.update({
      where: { id: historical.record.id },
      data: {
        details: {
          ...objectValue(historical.record.details),
          posting: {
            ...objectValue(objectValue(historical.record.details).posting),
            raw: { internal_job_id: 456 },
          },
        },
      },
    });
    const frozen = { ...historical.input.manifest, identity: historical.record.identity };
    const attempt = await db.prisma.personalAttempt.create({
      data: {
        userId: f.user.id,
        recordId: historical.record.id,
        campaignId: historical.input.campaignId,
        mode: "submit",
        state: "submission_uncertain",
        submitAt: new Date(),
        leaseExpiresAt: new Date(0),
        leaseOwner: historical.input.leaseOwner,
        attemptNo: 1,
        policyDay: "2026-01-01",
        manifest: jsonValue(frozen),
        manifestHash: manifestHash(frozen),
      },
    });
    const oldReservation = await db.prisma.personalReservation.create({
      data: {
        userId: f.user.id,
        identity: historical.record.identity,
        url: historical.record.url,
        attemptId: attempt.id,
      },
    });
    const otherPost = await f.record();
    await withJob(otherPost.record, "456", otherPost.input);
    await expect(db.service.start(f.user.id, otherPost.input)).rejects.toThrow(
      "submission reservation",
    );
    expect(
      await db.prisma.personalReservation.findUnique({ where: { id: oldReservation.id } }),
    ).toEqual(oldReservation);
    expect(
      objectValue(
        (await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).manifest,
      ),
    ).toEqual(frozen);
  });

  it("revalidates the canonical employer job before crossing submit", async () => {
    const f = await personalFixture(db);
    const item = await f.record();
    const record = await withJob(item.record, "456", item.input);
    const evaluated = await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...objectValue(record.details),
          eligibilityContext: eligibilityContext(record, {
            settings: f.settings,
            evidence: f.resume,
          }),
        }),
      },
    });
    await refreshPersonalFixtureApproval(db, f.user.id, record.id, item.input.manifest);
    const attempt = await db.service.start(f.user.id, item.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await withJob(evaluated, "457");
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow();
    expect(
      (await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).submitAt,
    ).toBeNull();
  });
});
