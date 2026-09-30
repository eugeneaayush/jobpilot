import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersonalApprovalService } from "./approval.service";
import { PersonalHandoffService } from "./handoff.service";
import { manifestHash } from "./persistence-policy";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!url)("persistent browser handoff", () => {
  let db: PersonalTestDatabase;
  let service: PersonalHandoffService;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(url!);
    service = new PersonalHandoffService(db.prisma, db.service);
  });
  afterAll(async () => {
    await db?.dispose();
  });
  async function fixture() {
    const f = await personalFixture(db);
    const { record, input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const handoff = await service.request(f.user.id, attempt.id, {
      leaseOwner: attempt.leaseOwner,
      leaseGeneration: attempt.leaseGeneration,
      reason: "login",
    });
    return { ...f, record, attempt, handoff };
  }
  test("parking releases preparation but never submission identity; concurrent opens are fenced", async () => {
    const f = await fixture();
    expect(
      (await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).state,
    ).toBe("blocked");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: f.attempt.id } })).toBe(
      0,
    );
    const results = await Promise.allSettled([
      service.transition(f.user.id, f.attempt.id, "open", f.handoff),
      service.transition(f.user.id, f.attempt.id, "open", f.handoff),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = await service.get(f.user.id, f.attempt.id);
    expect(current.leaseGeneration).toBe(f.handoff.leaseGeneration + 1);
    expect(current.browserOpen).toBe(false);
    await expect(service.transition(f.user.id, f.attempt.id, "resume", current)).rejects.toThrow(
      "receipt",
    );
  });
  test("withdrawal fences authentication while status and cancellation remain available", async () => {
    const f = await fixture();
    const opened = await service.transition(f.user.id, f.attempt.id, "open", f.handoff);
    await service.authorize(f.user.id, f.attempt.id, opened);
    const approvals = new PersonalApprovalService(db.prisma, db.service);
    const review = await approvals.get(f.user.id, f.record.id, "session");
    await approvals.withdraw(f.user.id, review.approval!.id, f.record.id, "session", {
      expectedRecordVersion: review.recordVersion.toISOString(),
      packetHash: review.packetHash,
      nonce: review.nonce,
      confirm: true,
    });
    await expect(service.authorize(f.user.id, f.attempt.id, opened)).rejects.toThrow("withdrawn");
    await expect(service.transition(f.user.id, f.attempt.id, "heartbeat", opened)).rejects.toThrow(
      "withdrawn",
    );
    await expect(service.transition(f.user.id, f.attempt.id, "resume", opened)).rejects.toThrow(
      "withdrawn",
    );
    expect((await service.get(f.user.id, f.attempt.id)).status).toBe("open");
    expect((await service.transition(f.user.id, f.attempt.id, "cancel", opened)).status).toBe(
      "cancelled",
    );
  });
  test("verified session proof closes handoff and retains blocked state for separate recovery", async () => {
    const f = await fixture();
    const opened = await service.transition(f.user.id, f.attempt.id, "open", f.handoff);
    const proof = {
      handoffId: opened.handoffId,
      attemptId: f.attempt.id,
      recordId: f.record.id,
      manifestHash: f.attempt.manifestHash,
      postingContentHash: manifestHash(objectValue(f.record.details).posting),
      leaseGeneration: opened.leaseGeneration,
      sourceUrl: f.record.url,
      noSubmission: true,
      securityClear: true,
      applicationFormObserved: true,
      profileClosed: true,
      capturedAt: new Date().toISOString(),
    };
    const bytes = JSON.stringify(proof);
    const proofHash = sha256(bytes);
    const directory = join(db.root, "storage", f.user.id, "handoffs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const change of [
      { capturedAt: "invalid" },
      { noSubmission: false },
      { securityClear: false },
      { profileClosed: false },
      { postingContentHash: "0".repeat(64) },
    ]) {
      const invalidBytes = JSON.stringify({ ...proof, ...change });
      const invalidHash = sha256(invalidBytes);
      await writeFile(join(directory, `${invalidHash}.json`), invalidBytes, { mode: 0o600 });
      await expect(
        service.transition(f.user.id, f.attempt.id, "resume", {
          ...opened,
          proofHash: invalidHash,
        }),
      ).rejects.toThrow("does not prove");
    }
    await writeFile(join(directory, `${proofHash}.json`), bytes, { mode: 0o600 });
    const resolved = await service.transition(f.user.id, f.attempt.id, "resume", {
      ...opened,
      proofHash,
    });
    expect(resolved.status).toBe("resolved");
    const record = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    expect(record.state).toBe("blocked");
    expect(objectValue(objectValue(record.details).browserSessionEvidence).verified).toBe(true);
    expect(
      (await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).submitAt,
    ).toBeNull();
    await expect(
      service.transition(f.user.id, f.attempt.id, "resume", { ...opened, proofHash }),
    ).rejects.toThrow("expired");
  });
  test("cross-user, offline and possibly submitted attempts cannot open security sessions", async () => {
    const f = await fixture();
    const other = await personalFixture(db);
    await expect(service.get(other.user.id, f.attempt.id)).rejects.toThrow("not found");
    await db.prisma.personalAttempt.update({
      where: { id: f.attempt.id },
      data: { submitAt: new Date(), state: "submission_uncertain" },
    });
    await expect(service.transition(f.user.id, f.attempt.id, "open", f.handoff)).rejects.toThrow(
      "possible submission",
    );
    const offline = await personalFixture(db, "offline");
    const { input } = await offline.record();
    const attempt = await db.service.start(offline.user.id, input);
    await expect(
      service.request(offline.user.id, attempt.id, {
        leaseOwner: attempt.leaseOwner,
        leaseGeneration: attempt.leaseGeneration,
        reason: "captcha",
      }),
    ).rejects.toThrow("live mode");
  });
  test("lost leases require a new generation and reject prior proof", async () => {
    const f = await fixture();
    const opened = await service.transition(f.user.id, f.attempt.id, "open", f.handoff);
    const record = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: {
          ...objectValue(record.details),
          handoff: { ...opened, leaseExpiresAt: "2020-01-01T00:00:00.000Z" },
        },
      },
    });
    const expired = await service.get(f.user.id, f.attempt.id);
    expect(expired.status).toBe("expired");
    const reopened = await service.transition(f.user.id, f.attempt.id, "open", expired);
    expect(reopened.leaseGeneration).toBe(opened.leaseGeneration + 1);
    await expect(service.transition(f.user.id, f.attempt.id, "heartbeat", opened)).rejects.toThrow(
      "ownership",
    );
  });
});
