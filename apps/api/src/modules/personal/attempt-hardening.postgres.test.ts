import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal attempt durable completion and artifact boundaries", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("finishes offline previews durably and keeps their quota debit", async () => {
    const f = await personalFixture(db, "offline", 1);
    const { input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const lease = { leaseOwner: attempt.leaseOwner, leaseGeneration: attempt.leaseGeneration };
    await db.service.prepare(f.user.id, attempt.id, lease);
    await expect(
      db.service.finishPreview(f.user.id, attempt.id, lease, "0".repeat(64)),
    ).rejects.toThrow("manifest hash");
    const finished = await db.service.finishPreview(
      f.user.id,
      attempt.id,
      lease,
      attempt.manifestHash,
    );
    expect(finished.state).toBe("previewed");
    const replay = await db.service.finishPreview(
      f.user.id,
      attempt.id,
      lease,
      attempt.manifestHash,
    );
    expect(replay).toEqual(finished);
    await expect(
      db.service.finishPreview(
        f.user.id,
        attempt.id,
        { ...lease, leaseOwner: "other" },
        attempt.manifestHash,
      ),
    ).rejects.toThrow("replay does not match");
    expect(finished.submitAt).toBeNull();
    expect(finished.receipt).toMatchObject({
      outcome: "previewed",
      manifestHash: attempt.manifestHash,
    });
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(0);
    const fresh = await f.record();
    await expect(db.service.start(f.user.id, fresh.input)).rejects.toThrow("cap reached");
    await expect(db.service.cancel(f.user.id, attempt.id, lease)).rejects.toThrow("Lease is stale");
    expect((await db.service.get(f.user.id, attempt.id)).state).toBe("previewed");
  });

  it("parks affected preparations and refuses retries without evidence-based recovery", async () => {
    const f = await personalFixture(db, "offline");
    const { input, record } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const parked = await db.service.park(
      f.user.id,
      attempt.id,
      attempt,
      "blocked",
      "Required employer answer is unavailable",
    );
    expect(parked.state).toBe("blocked");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(
      (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).state,
    ).toBe("blocked");
    await expect(db.service.start(f.user.id, input)).rejects.toThrow("evidence-based recovery");
  });

  it("parking after begin-submit retains a possible submission permanently", async () => {
    const f = await personalFixture(db);
    const { input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.service.beginSubmit(f.user.id, attempt.id, attempt);
    const parked = await db.service.park(
      f.user.id,
      attempt.id,
      attempt,
      "failed",
      "Worker disconnected after submit began",
    );
    expect(parked.state).toBe("submission_uncertain");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
    await expect(db.service.start(f.user.id, input)).rejects.toThrow("unresolved submission");
  });

  it("rejects same-hash documents outside the user's root and symlink escapes", async () => {
    const f = await personalFixture(db);
    const other = await personalFixture(db);
    const { input } = await f.record();
    const bad = {
      ...input,
      manifest: { ...input.manifest, document: { path: other.artifactPath, sha256: db.hash } },
    };
    await expect(db.service.start(f.user.id, bad)).rejects.toThrow("outside private user storage");
    const link = join(dirname(f.artifactPath), "foreign-link.txt");
    await symlink(other.artifactPath, link);
    await expect(
      db.service.start(f.user.id, {
        ...bad,
        manifest: { ...bad.manifest, document: { path: link, sha256: db.hash } },
      }),
    ).rejects.toThrow("outside private user storage");
    const attempt = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.service.beginSubmit(f.user.id, attempt.id, attempt);
    await expect(
      db.service.reconcile(f.user.id, attempt.id, {
        outcome: "submitted",
        kind: "confirmation_page",
        artifactPath: other.artifactPath,
        sha256: db.hash,
        sourceUrl: "https://example.test/confirmation",
        capturedAt: new Date().toISOString(),
        details: "Foreign artifact",
        manifestHash: attempt.manifestHash,
      }),
    ).rejects.toThrow("outside private user storage");
  });

  it("freezes employer requisition identity and rejects altered stored identities", async () => {
    const f = await personalFixture(db);
    const { input, record } = await f.record();
    const attempt = await db.service.start(f.user.id, {
      ...input,
      manifest: {
        ...input.manifest,
        identity: "forged",
        requisitionId: "forged",
        company: "Other",
      },
    });
    expect(attempt.manifest).toMatchObject({
      identity: record.identity,
      requisitionId: record.requisitionId,
      company: record.company,
    });
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: { requisitionId: "different-job" },
    });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "trusted employer requisition",
    );
  });
  it("rejects changed posting content before the submit boundary", async () => {
    const f = await personalFixture(db);
    const { input, record } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: {
          ...objectValue(record.details),
          posting: {
            ...objectValue(objectValue(record.details).posting),
            contentHash: "b".repeat(64),
            descriptionText: `Changed requirements. ${objectValue(objectValue(record.details).posting).descriptionText}`,
          },
        },
      },
    });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "Attachment requirements belong to an earlier posting",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
  });

  it("rejects changed recruiting settings before the submit boundary", async () => {
    const f = await personalFixture(db);
    const { input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await mkdir(join(db.root, "settings"), { recursive: true });
    await writeFile(
      join(db.root, "settings", `${f.user.id}.json`),
      JSON.stringify({ ...f.settings, locations: ["Changed city"] }),
    );
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "Recruiting settings changed",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
  });
  it("never reclaims a timed-out submit boundary while sweeping preparation caps", async () => {
    const f = await personalFixture(db, "submit", 1);
    const first = await f.record();
    const attempt = await db.service.start(f.user.id, first.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.service.beginSubmit(f.user.id, attempt.id, attempt);
    await db.prisma.personalAttempt.update({
      where: { id: attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const second = await f.record();
    await expect(db.service.start(f.user.id, second.input)).rejects.toThrow("cap reached");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
    expect((await db.service.get(f.user.id, attempt.id)).state).toBe("submission_uncertain");
  });
  it("new factual evidence revokes an already prepared final-submit permit", async () => {
    const f = await personalFixture(db);
    const { input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.prisma.personalResumeEvidence.create({
      data: {
        userId: f.user.id,
        resumeId: crypto.randomUUID(),
        sourceHash: db.hash,
        details: { conflicts: ["New unresolved employment date"] },
      },
    });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "Resume evidence changed",
    );
    const stored = await db.service.get(f.user.id, attempt.id);
    expect(stored.submitAt).toBeNull();
    expect(stored.state).toBe("prepared");
  });
});
