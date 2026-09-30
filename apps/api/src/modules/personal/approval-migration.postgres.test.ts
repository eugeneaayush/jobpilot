import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const connection = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!connection)("application approval data migration", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(connection!);
  }, 30_000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  test("pauses existing live policies without changing attempts, reservations, documents, or general campaigns", async () => {
    const live = await personalFixture(db);
    const prepared = await live.record();
    const attempt = await db.service.start(live.user.id, prepared.input);
    await db.service.prepare(live.user.id, attempt.id, attempt);
    await db.service.beginSubmit(live.user.id, attempt.id, attempt);
    await db.prisma.personalAttempt.update({
      where: { id: attempt.id },
      data: { state: "submission_uncertain" },
    });
    const offline = await personalFixture(db, "offline");
    const general = await db.prisma.campaign.create({
      data: {
        userId: live.user.id,
        query: "General plugin fixture",
        source: "apply",
        status: "in_progress",
        config: { autoApply: true },
      },
    });
    const preview = await db.prisma.campaign.create({
      data: {
        userId: live.user.id,
        query: "Legacy live preview",
        source: "apply",
        status: "in_progress",
        config: {
          personal: { mode: "live_preview", enabled: true, authorization: { runId: "legacy" } },
        },
      },
    });
    const oldAttempt = await db.prisma.personalAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    const reservations = await db.prisma.personalReservation.findMany({
      where: { userId: live.user.id },
    });
    const record = await db.prisma.personalRecord.findUniqueOrThrow({
      where: { id: prepared.record.id },
    });
    const sql = await readFile(
      join(
        import.meta.dir,
        "../../../prisma/migrations/20260930020000_require_personal_application_approval/migration.sql",
      ),
      "utf8",
    );
    await db.prisma.$executeRawUnsafe(sql);
    for (const id of [live.campaign.campaignId, preview.campaignId]) {
      const campaign = await db.prisma.campaign.findUniqueOrThrow({ where: { campaignId: id } });
      expect(campaign.status).toBe("paused");
      expect(objectValue(campaign.config).personal).toMatchObject({
        approvalPolicy: "per-application-v1",
        enabled: false,
        authorization: null,
      });
    }
    const draft = await db.prisma.campaign.findUniqueOrThrow({
      where: { campaignId: offline.campaign.campaignId },
    });
    expect(draft.status).toBe(offline.campaign.status);
    expect(objectValue(draft.config).personal).toMatchObject({
      enabled: true,
      mode: "offline",
      approvalPolicy: "per-application-v1",
    });
    expect(
      await db.prisma.campaign.findUniqueOrThrow({ where: { campaignId: general.campaignId } }),
    ).toEqual(general);
    expect(
      await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toEqual(oldAttempt);
    expect(
      await db.prisma.personalReservation.findMany({ where: { userId: live.user.id } }),
    ).toEqual(reservations);
    expect(
      await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: prepared.record.id } }),
    ).toEqual(record);
    await expect(
      db.prisma.$transaction((tx) =>
        db.service.verifyContinuationManifest(tx, live.user.id, oldAttempt),
      ),
    ).rejects.toThrow();
  });
});
