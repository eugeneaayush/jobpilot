import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonalDiscoveryService } from "../discovery.service";
import type { PersonalTestDatabase } from "../persistence-test-fixtures";
import { syntheticLeadCandidate } from "./fakes";
import { PersonalLeadsService } from "./leads.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("lead PostgreSQL persistence and import races", () => {
  let db: PersonalTestDatabase;
  let service: PersonalLeadsService;
  let userId: string;
  beforeAll(async () => {
    const { createPersonalTestDatabase } = await import("../persistence-test-fixtures");
    db = await createPersonalTestDatabase(testUrl!);
    const user = await db.prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test`, username: crypto.randomUUID() },
    });
    userId = user.id;
    await writeFile(path.join(db.root, "runtime.json"), JSON.stringify({ account: { userId } }));
    service = new PersonalLeadsService(db.prisma, {} as PersonalDiscoveryService);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  test("concurrent imports preserve both snapshots while creating one unverified lead", async () => {
    const outcomes = await Promise.all([
      service.import(userId, { candidates: [syntheticLeadCandidate] }),
      service.import(userId, {
        candidates: [{ ...syntheticLeadCandidate, sourceRowId: "duplicate-row" }],
      }),
    ]);
    expect(outcomes.reduce((sum, item) => sum + item.imported, 0)).toBe(1);
    expect(outcomes.reduce((sum, item) => sum + item.duplicates, 0)).toBe(1);
    expect(
      await db.prisma.personalDiscoveryRun.count({
        where: { userId, source: "lead_batch:manual" },
      }),
    ).toBe(2);
    expect(await db.prisma.personalRecord.count({ where: { userId } })).toBe(0);
    const page = await service.list(userId, {
      page: 1,
      limit: 1,
      source: "manual",
      status: "unresolved",
    });
    expect(page.pagination).toMatchObject({ total: 1, totalPages: 1, page: 1, limit: 1 });
    expect(page.items[0]?.employerIdentityVerified).toBe(false);
    expect((await service.list(userId, { page: 2, limit: 1 })).items).toHaveLength(0);
    expect(
      (await service.list(userId, { page: 1, limit: 1, status: "resolved" })).pagination.total,
    ).toBe(0);
  });
});
