import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonalTestDatabase } from "../persistence-test-fixtures";
import type { PersonalPreparationService } from "../preparation.service";
import { jsonValue, objectValue } from "../runtime";
import { PersonalBatchesService } from "./batches.service";
import { batchFixture } from "./fakes";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("batch PostgreSQL checkpoint races", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    const { createPersonalTestDatabase } = await import("../persistence-test-fixtures");
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  async function fixture() {
    const value = batchFixture();
    await db.prisma.user.create({
      data: { id: value.userId, email: `${value.userId}@example.test`, username: value.userId },
    });
    await writeFile(
      path.join(db.root, "runtime.json"),
      JSON.stringify({ account: { userId: value.userId } }),
    );
    await db.prisma.campaign.create({
      data: {
        ...value.campaign,
        status: "in_progress",
        query: "Synthetic batch checkpoint",
        source: "apply",
      },
    });
    await db.prisma.personalResumeEvidence.create({ data: value.evidence });
    await db.prisma.personalRecord.createMany({
      data: value.records.map((record) => ({ ...record, details: jsonValue(record.details) })),
    });
    return {
      ...value,
      service: new PersonalBatchesService(db.prisma, value.personal, value.preparation),
    };
  }

  test("concurrent creation binds every member to one analysis and one shared question", async () => {
    const f = await fixture();
    const input = { campaignId: f.campaignId, recordIds: f.records.map((record) => record.id) };
    const [first, second] = await Promise.all([
      f.service.create(f.userId, input),
      f.service.create(f.userId, input),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.analysisHash).toBe(second.analysisHash);
    expect(await db.prisma.personalDiscoveryRun.count({ where: { userId: f.userId } })).toBe(1);
    expect(
      await db.prisma.pilotQuestion.count({ where: { userId: f.userId, subjectId: first.id } }),
    ).toBe(1);
    const members = await db.prisma.personalRecord.findMany({ where: { userId: f.userId } });
    for (const member of members) {
      expect(objectValue(objectValue(member.details).tailoringBatch).analysisHash).toBe(
        first.analysisHash,
      );
      expect(objectValue(member.details).tailoringBatchHistory).toEqual([]);
    }
    const page = await f.service.list(f.userId, { page: 1, limit: 1 });
    expect(page.pagination.total).toBe(1);
    expect(page.items[0]?.id).toBe(first.id);
  });

  test("concurrent advance fences the losing worker and preserves the next member after a failure", async () => {
    const f = await fixture();
    const created = await f.service.create(f.userId, {
      campaignId: f.campaignId,
      recordIds: f.records.map((record) => record.id),
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const called: string[] = [];
    const preparation = {
      advance: async (_userId: string, recordId: string) => {
        called.push(recordId);
        if (called.length === 1) {
          started.resolve();
          await release.promise;
          throw new Error("Synthetic checkpoint failure");
        }
        return { status: "pending", phase: "claim_review", reason: null, nextEligibleAt: null };
      },
    } as unknown as PersonalPreparationService;
    const service = new PersonalBatchesService(db.prisma, f.personal, preparation);
    const input = { expectedAnalysisHash: created.analysisHash, retryBlocked: false };
    const first = service.advance(f.userId, created.id, input);
    await started.promise;
    try {
      await expect(service.advance(f.userId, created.id, input)).rejects.toThrow("Another worker");
      expect(called).toHaveLength(1);
    } finally {
      release.resolve();
    }
    const failed = await first;
    expect(failed.members.find((member) => member.recordId === called[0])?.status).toBe("blocked");
    expect(failed.running).toBe(false);
    await service.advance(f.userId, created.id, input);
    expect(called).toHaveLength(2);
    expect(called[1]).not.toBe(called[0]);
    expect(await db.prisma.pilotQuestion.count({ where: { userId: f.userId } })).toBe(1);
    expect(await db.prisma.personalAttempt.count({ where: { userId: f.userId } })).toBe(0);
  });
});
