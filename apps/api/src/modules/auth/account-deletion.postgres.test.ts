import { HttpError } from "@/common/errors";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "../personal/persistence-test-fixtures";
import { deleteAccountRecords } from "./account-deletion";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

async function seedAccount(db: PersonalTestDatabase) {
  const tag = crypto.randomUUID();
  const user = await db.prisma.user.create({
    data: { email: `${tag}@example.test`, username: tag },
  });
  const resume = await db.prisma.resume.create({
    data: { userId: user.id, label: "Main", sourceFilename: `${tag}.pdf` },
  });
  const variant = await db.prisma.resumeVariant.create({
    data: { resumeId: resume.id, label: "Tailored", content: "{}" },
  });
  await db.prisma.user.update({ where: { id: user.id }, data: { primaryResumeId: resume.id } });
  await db.prisma.campaign.create({
    data: { userId: user.id, query: "Synthetic", source: "apply", config: {} },
  });
  await db.prisma.application.create({
    data: {
      userId: user.id,
      url: `https://example.test/${tag}`,
      title: "Analyst",
      company: "Example",
      source: "manual",
      resumeId: resume.id,
    },
  });
  await db.prisma.contact.create({ data: { userId: user.id, name: "Synthetic Contact" } });
  await db.prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: `refresh-${tag}`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await db.prisma.apiToken.create({
    data: { userId: user.id, name: "agent", tokenHash: `api-${tag}` },
  });
  await db.prisma.oAuthAccount.create({
    data: { userId: user.id, provider: "GOOGLE", providerAccountId: tag },
  });
  await db.prisma.pushSubscription.create({
    data: { userId: user.id, endpoint: `https://push.example.test/${tag}`, p256dh: "k", auth: "a" },
  });
  return { user, resume, variant };
}

/** Rows per table that still point at the user, across every table with a user_id column. */
async function remainingRows(db: PersonalTestDatabase, userId: string) {
  const tables = await db.prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'user_id'`;
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [row] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${table_name}" WHERE user_id::text = $1`,
      userId,
    );
    if (row && row.n > 0n) counts[table_name] = Number(row.n);
  }
  return counts;
}

const connection = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!connection)("account deletion against the migrated schema", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(connection!);
  }, 30_000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  test("every foreign key into users cascades", async () => {
    const blocking = await db.prisma.$queryRaw<{ table: string; constraint: string }[]>`
      SELECT conrelid::regclass::text AS table, conname AS constraint
      FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'users'::regclass AND confdeltype <> 'c'`;
    expect(blocking).toEqual([]);
  });

  test("removes every row the user owns and leaves other accounts intact", async () => {
    const doomed = await seedAccount(db);
    const kept = await seedAccount(db);
    const keptBefore = await remainingRows(db, kept.user.id);

    const files = await deleteAccountRecords(db.prisma, doomed.user.id);

    expect(files).toEqual([
      {
        resumeId: doomed.resume.id,
        sourceFilename: doomed.resume.sourceFilename,
        variantIds: [doomed.variant.id],
      },
    ]);
    expect(await db.prisma.user.findUnique({ where: { id: doomed.user.id } })).toBeNull();
    expect(await remainingRows(db, doomed.user.id)).toEqual({});
    expect(await db.prisma.resumeVariant.count({ where: { id: doomed.variant.id } })).toBe(0);
    expect(await remainingRows(db, kept.user.id)).toEqual(keptBefore);
    expect(Object.keys(keptBefore).length).toBeGreaterThanOrEqual(8);
  });

  test("waits for an in-flight resume insert and includes its file", async () => {
    const { user } = await seedAccount(db);
    let inserted!: () => void;
    let release!: () => void;
    const insertedSignal = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.prisma.$transaction(
      async (tx) => {
        await tx.resume.create({
          data: { userId: user.id, label: "Late upload", sourceFilename: "late-upload.pdf" },
        });
        inserted();
        await gate;
      },
      { timeout: 10_000 },
    );
    await insertedSignal;

    const deletion = deleteAccountRecords(db.prisma, user.id);
    // Let the deletion reach its row locks while the insert is still uncommitted.
    await Bun.sleep(300);
    release();
    await writer;

    expect((await deletion).map((file) => file.sourceFilename)).toContain("late-upload.pdf");
  });

  test("waits for an in-flight source replacement and lists the new file", async () => {
    const { user, resume } = await seedAccount(db);
    let updated!: () => void;
    let release!: () => void;
    const updatedSignal = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.prisma.$transaction(
      async (tx) => {
        await tx.resume.update({
          where: { id: resume.id },
          data: { sourceFilename: "replaced-source.pdf" },
        });
        updated();
        await gate;
      },
      { timeout: 10_000 },
    );
    await updatedSignal;

    const deletion = deleteAccountRecords(db.prisma, user.id);
    await Bun.sleep(300);
    release();
    await writer;

    expect((await deletion).map((file) => file.sourceFilename)).toEqual(["replaced-source.pdf"]);
  });

  test("keeps its locks until the delete, so a resume insert arriving mid-deletion fails", async () => {
    const { user, resume } = await seedAccount(db);
    let held!: () => void;
    let release!: () => void;
    const heldSignal = new Promise<void>((resolve) => {
      held = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stalls the deletion at its resume lock, after it already holds the user lock.
    const blocker = db.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM resumes WHERE id = ${resume.id} FOR UPDATE`;
        held();
        await gate;
      },
      { timeout: 10_000 },
    );
    await heldSignal;

    const deletion = deleteAccountRecords(db.prisma, user.id);
    await Bun.sleep(300);
    const lateInsert = db.prisma.resume
      .create({ data: { userId: user.id, label: "Too late", sourceFilename: "too-late.pdf" } })
      .then(
        () => "inserted",
        (error: unknown) => error,
      );
    await Bun.sleep(300);
    release();
    await blocker;
    await deletion;

    expect(await lateInsert).toBeInstanceOf(Error);
    expect(await db.prisma.resume.count({ where: { sourceFilename: "too-late.pdf" } })).toBe(0);
  });

  test("refuses an account that owns a personal attempt ledger", async () => {
    const owner = await personalFixture(db);
    const prepared = await owner.record();
    await db.service.start(owner.user.id, prepared.input);

    const error = await deleteAccountRecords(db.prisma, owner.user.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect(await db.prisma.user.findUnique({ where: { id: owner.user.id } })).not.toBeNull();
  });
});
