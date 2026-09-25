import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("graduate policy at the transactional submission boundary", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("a campaign cannot raise the user cap above 50", async () => {
    const f = await personalFixture(db, "submit", 100);
    const source = await f.record();
    await db.prisma.personalPolicy.create({ data: { userId: f.user.id, dailyCap: 1 } });
    await db.service.start(f.user.id, source.input);
    const second = await f.record();
    await expect(db.service.start(f.user.id, second.input)).rejects.toThrow("cap reached");
    await expect(
      Promise.resolve(
        db.prisma.personalPolicy.update({ where: { userId: f.user.id }, data: { dailyCap: 51 } }),
      ),
    ).rejects.toThrow();
  });

  it("reserves only three concurrent applications to one employer", async () => {
    const f = await personalFixture(db, "submit", 50);
    const records = await Promise.all(Array.from({ length: 5 }, () => f.record()));
    const results = await Promise.allSettled(
      records.map((r) => db.service.start(f.user.id, r.input)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(3);
  });

  it("blocks undergraduate records even when saved eligibility and manifest claim ready", async () => {
    const f = await personalFixture(db);
    const r = await f.record();
    const details = r.record.details as Record<string, unknown>;
    await db.prisma.personalRecord.update({
      where: { id: r.record.id },
      data: {
        title: "Business Analyst Intern",
        details: {
          ...details,
          posting: {
            ...(details.posting as Record<string, unknown>),
            descriptionText: "Candidates must be undergraduate students graduating in 2028.",
          },
        } as never,
      },
    });
    await expect(db.service.start(f.user.id, r.input)).rejects.toThrow("Undergraduate");
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(0);
  });
});
