import { rm } from "node:fs/promises";
import { join } from "node:path";
import { personalDocumentVerificationSchema } from "@jobpilot/contracts/personal-local-tools";
import { PersonalApprovalService } from "./approval.service";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("application approval PostgreSQL invariants", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("does not reserve a live attempt while waiting for human review", async () => {
    const fixture = await personalFixture(db, "submit", 3, false);
    const { input } = await fixture.record();
    await expect(db.service.start(fixture.user.id, input)).rejects.toThrow("Review and approve");
    expect(await db.prisma.personalReservation.count({ where: { userId: fixture.user.id } })).toBe(
      0,
    );
  });

  it("does not accept a passed verification flag without its immutable report artifact", async () => {
    const fixture = await personalFixture(db, "submit", 3, false);
    const { record, input } = await fixture.record();
    const report = personalDocumentVerificationSchema.parse(
      objectValue(record.details).documentVerification,
    );
    const hash = sha256(JSON.stringify(report, null, 2));
    await rm(join(db.root, "storage", fixture.user.id, "document-checks", `${hash}.json`));
    const review = await new PersonalApprovalService(db.prisma, db.service).get(
      fixture.user.id,
      record.id,
      "session",
    );
    expect(review.blockers.length).toBeGreaterThan(0);
    await expect(db.service.start(fixture.user.id, input)).rejects.toThrow();
    expect(await db.prisma.personalAttempt.count({ where: { recordId: record.id } })).toBe(0);
  });

  it("holds live readiness when document verification is unavailable", async () => {
    const fixture = await personalFixture(db, "submit", 3, false);
    const { record } = await fixture.record();
    const details = objectValue(record.details);
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...details,
          documentVerification: {
            ...objectValue(details.documentVerification),
            status: "unavailable",
          },
        }),
      },
    });
    const review = await new PersonalApprovalService(db.prisma, db.service).get(
      fixture.user.id,
      record.id,
      "session",
    );
    expect(review.blockers.join(" ")).toContain("deterministic document verification");
  });

  it("holds already reviewed PDFs after renderer or verifier configuration changes", async () => {
    for (const change of [
      { document: { rendererConfigHash: "0".repeat(64) } },
      { document: { documentPipelineVersion: "private-documents-v2" } },
      { documentVerification: { verifierConfigHash: "0".repeat(64) } },
    ]) {
      const fixture = await personalFixture(db, "submit", 3, false);
      const { record, input } = await fixture.record();
      const details = objectValue(record.details);
      const changed = Object.fromEntries(
        Object.entries(change).map(([key, value]) => [
          key,
          { ...objectValue(details[key]), ...value },
        ]),
      );
      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: { details: jsonValue({ ...details, ...changed }) },
      });
      const review = await new PersonalApprovalService(db.prisma, db.service).get(
        fixture.user.id,
        record.id,
        "session",
      );
      expect(review.blockers.join(" ")).toMatch(
        /Current (renderer configuration|deterministic document verification)/,
      );
      await expect(db.service.start(fixture.user.id, input)).rejects.toThrow();
      expect(await db.prisma.personalAttempt.count({ where: { recordId: record.id } })).toBe(0);
    }
  });

  it("accepts exactly one racing approval for a reviewed record version", async () => {
    const fixture = await personalFixture(db, "submit", 3, false);
    const { record } = await fixture.record();
    const service = new PersonalApprovalService(db.prisma, db.service);
    const review = await service.get(fixture.user.id, record.id, "session");
    const input = {
      expectedRecordVersion: review.recordVersion.toISOString(),
      packetHash: review.packetHash,
      nonce: review.nonce,
      confirm: true as const,
    };
    const outcomes = await Promise.allSettled([
      service.approve(fixture.user.id, record.id, "session", input),
      service.approve(fixture.user.id, record.id, "session", input),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("binds one attempt and withdrawing fences its lease", async () => {
    const fixture = await personalFixture(db);
    const { record, input } = await fixture.record();
    const started = await db.service.start(fixture.user.id, input);
    const service = new PersonalApprovalService(db.prisma, db.service);
    const review = await service.get(fixture.user.id, record.id, "session");
    expect(review.approval?.status).toBe("bound");
    await service.withdraw(fixture.user.id, review.approval!.id, record.id, "session", {
      expectedRecordVersion: review.recordVersion.toISOString(),
      packetHash: review.packetHash,
      nonce: review.nonce,
      confirm: true,
    });
    await expect(
      db.service.checkpoint(fixture.user.id, started.id, {
        leaseOwner: started.leaseOwner,
        leaseGeneration: started.leaseGeneration,
      }),
    ).rejects.toThrow("Lease is stale");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: started.id } })).toBe(0);
    await expect(db.service.start(fixture.user.id, input)).rejects.toThrow("withdrawn");
  });

  it("does not free an uncertain submission when approval is withdrawn", async () => {
    const fixture = await personalFixture(db);
    const { record, input } = await fixture.record();
    const started = await db.service.start(fixture.user.id, input);
    await db.prisma.personalAttempt.update({
      where: { id: started.id },
      data: { state: "submission_uncertain", submitAt: new Date() },
    });
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: { state: "submission_uncertain" },
    });
    const service = new PersonalApprovalService(db.prisma, db.service);
    const review = await service.get(fixture.user.id, record.id, "session");
    await service.withdraw(fixture.user.id, review.approval!.id, record.id, "session", {
      expectedRecordVersion: review.recordVersion.toISOString(),
      packetHash: review.packetHash,
      nonce: review.nonce,
      confirm: true,
    });
    expect(await db.prisma.personalReservation.count({ where: { attemptId: started.id } })).toBe(1);
    expect(
      (await db.prisma.personalAttempt.findUniqueOrThrow({ where: { id: started.id } })).state,
    ).toBe("submission_uncertain");
  });

  it("rechecks packet changes before a worker can continue filling", async () => {
    const fixture = await personalFixture(db);
    const { record, input } = await fixture.record();
    const attempt = await db.service.start(fixture.user.id, input);
    const current = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...objectValue(current.details),
          applicationEmail: { payloadHash: "changed" },
        }),
      },
    });
    await expect(
      db.service.checkpoint(fixture.user.id, attempt.id, {
        leaseOwner: attempt.leaseOwner,
        leaseGeneration: attempt.leaseGeneration,
      }),
    ).rejects.toThrow("stale");
  });
});
