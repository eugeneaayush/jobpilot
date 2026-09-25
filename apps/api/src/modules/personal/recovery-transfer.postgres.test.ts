import { personalRecoveryResponseSchema } from "@jobpilot/contracts/personal-recovery";
import { createPersonalTestDatabase, type PersonalTestDatabase } from "./persistence-test-fixtures";
import { recoveryTransferFixture } from "./recovery-transfer-test-fixtures";
import { jsonValue, objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("recovery transfer to an authorized current campaign", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("uses current target snapshot, retains original history and requires fresh preparation before selection", async () => {
    const f = await recoveryTransferFixture(db);
    const old = await f.recovery.get(f.user.id, f.record.id);
    expect(old.recovery.blockers).toContain("Campaign source snapshot changed");
    const targeted = await f.recovery.get(f.user.id, f.record.id, f.target.id);
    expect(targeted.recovery.allowed).toBe(true);
    expect(targeted.recovery.targetCampaignId).toBe(f.target.id);
    expect(personalRecoveryResponseSchema.safeParse(targeted).success).toBe(true);
    await f.recovery.recover(f.user.id, f.record.id, await f.recoverInput());
    const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    const details = objectValue(row.details);
    expect(details.preview).toBeUndefined();
    expect(details.document).toBeUndefined();
    expect(details.manifestPath).toBeUndefined();
    expect(objectValue(details.recoveryTicket)).toMatchObject({
      fromAttemptId: f.attempt.id,
      originalCampaignId: f.original.id,
      originalCampaignRunId: f.original.authorization!.runId,
      campaignId: f.target.id,
      campaignRunId: f.target.authorization!.runId,
    });
    expect(details.recoveryHistory).toHaveLength(1);
    expect((await db.service.get(f.user.id, f.attempt.id)).state).toBe("blocked");
    expect((await f.campaigns.next(f.user.id, f.target.id, "synthetic")).status).toBe("idle");
    await f.prepare();
    const next = await f.campaigns.next(f.user.id, f.target.id, "synthetic");
    expect(next.status).toBe("task");
    if (next.status !== "task") throw new Error(next.reasons.join("; "));
    expect(next.attempt.id).not.toBe(f.attempt.id);
    const saved = await db.service.get(f.user.id, next.attempt.id);
    expect(objectValue(saved.manifest).recoveryRevision).toBe(
      objectValue(details.recoveryTicket).revision,
    );
    expect(saved.attemptNo).toBe(f.attempt.attemptNo + 1);
    expect(saved.campaignId).toBe(f.target.id);
  });

  it("rejects foreign, stopped and out-of-scope target campaigns", async () => {
    const f = await recoveryTransferFixture(db);
    const foreign = await recoveryTransferFixture(db);
    await expect(
      f.recovery.recover(f.user.id, f.record.id, await f.recoverInput(foreign.target.id)),
    ).rejects.toThrow("Target campaign is unavailable");
    await f.campaigns.stop(f.user.id, f.target.id);
    const stopped = await f.recovery.get(f.user.id, f.record.id, f.target.id);
    expect(stopped.recovery.allowed).toBe(false);
    await expect(
      f.recovery.recover(f.user.id, f.record.id, await f.recoverInput()),
    ).rejects.toThrow("must be active");
    const outside = await f.campaigns.launch(f.user.id, (await f.create("another-board")).id, true);
    await expect(
      f.recovery.recover(f.user.id, f.record.id, await f.recoverInput(outside.id)),
    ).rejects.toThrow("Source is outside");
  });

  it("rejects stale target runs and target snapshot changes", async () => {
    const f = await recoveryTransferFixture(db);
    const input = await f.recoverInput();
    await f.campaigns.stop(f.user.id, f.target.id);
    await f.campaigns.launch(f.user.id, f.target.id, true);
    await expect(f.recovery.recover(f.user.id, f.record.id, input)).rejects.toThrow(
      "authorization changed",
    );
    const row = await db.prisma.campaign.findUniqueOrThrow({ where: { campaignId: f.target.id } });
    const personal = objectValue(objectValue(row.config).personal);
    await db.prisma.campaign.update({
      where: { campaignId: row.campaignId },
      data: {
        config: jsonValue({
          ...objectValue(row.config),
          personal: {
            ...personal,
            authorization: { ...objectValue(personal.authorization), sourceHash: "0".repeat(64) },
          },
        }),
      },
    });
    await expect(
      f.recovery.recover(f.user.id, f.record.id, await f.recoverInput()),
    ).rejects.toThrow("snapshot changed");
  });

  it("accepts exactly one competing transfer and keeps the losing target without a ticket", async () => {
    const f = await recoveryTransferFixture(db);
    const other = await f.campaigns.launch(f.user.id, (await f.create()).id, true);
    const inputs = await Promise.all([f.recoverInput(), f.recoverInput(other.id)]);
    const results = await Promise.allSettled(
      inputs.map((input) => f.recovery.recover(f.user.id, f.record.id, input)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    expect(objectValue(row.details).recoveryHistory).toHaveLength(1);
    const ticket = objectValue(objectValue(row.details).recoveryTicket);
    await f.prepare();
    const losing = ticket.campaignId === f.target.id ? other.id : f.target.id;
    const denied = await f.campaigns.next(f.user.id, losing, "synthetic");
    expect(denied.status).toBe("idle");
    expect(await db.prisma.personalAttempt.count({ where: { recordId: f.record.id } })).toBe(1);
  });

  it("a possible submission in original history cannot transfer even when the latest block has no submit timestamp", async () => {
    const f = await recoveryTransferFixture(db);
    const historical = await db.prisma.personalAttempt.create({
      data: {
        userId: f.user.id,
        recordId: f.record.id,
        campaignId: f.original.id,
        mode: "submit",
        state: "submission_uncertain",
        attemptNo: 0,
        manifest: f.attempt.manifest!,
        manifestHash: f.attempt.manifestHash,
        leaseOwner: "synthetic-history",
        leaseExpiresAt: new Date(0),
        policyDay: f.attempt.policyDay,
        submitAt: new Date(1),
        startedAt: new Date(0),
      },
    });
    await db.prisma.personalReservation.create({
      data: {
        userId: f.user.id,
        identity: f.record.identity,
        url: f.record.url,
        attemptId: historical.id,
      },
    });
    const before = await f.recoverInput();
    await expect(f.recovery.recover(f.user.id, f.record.id, before)).rejects.toThrow(
      "reconciliation",
    );
    expect(await db.prisma.personalReservation.count({ where: { attemptId: historical.id } })).toBe(
      1,
    );
    expect((await db.service.get(f.user.id, f.attempt.id)).submitAt).toBeNull();
  });

  it("target relaunch rejects the old ticket and permits one explicit fresh-proof reissue", async () => {
    const f = await recoveryTransferFixture(db);
    await f.recovery.recover(f.user.id, f.record.id, await f.recoverInput());
    const before = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    const originalTicket = objectValue(objectValue(before.details).recoveryTicket);
    await expect(
      f.recovery.recover(f.user.id, f.record.id, await f.recoverInput()),
    ).rejects.toThrow("already has a recovery revision");
    await f.prepare();
    await f.campaigns.stop(f.user.id, f.target.id);
    await f.campaigns.launch(f.user.id, f.target.id, true);
    const result = await f.campaigns.next(f.user.id, f.target.id, "synthetic");
    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("Old transfer unexpectedly selected");
    expect(result.reasons).toContain(
      "Recovery transfer belongs to a different target campaign run.",
    );
    expect(await db.prisma.personalAttempt.count({ where: { recordId: f.record.id } })).toBe(1);
    const view = await f.recovery.get(f.user.id, f.record.id, f.target.id);
    expect(view.recovery.allowed).toBe(true);
    await expect(
      f.recovery.recover(f.user.id, f.record.id, await f.recoverInput()),
    ).rejects.toThrow("fresh immutable answer snapshot");
    await f.refreshAnswers();
    const input = await f.recoverInput();
    const reissues = await Promise.allSettled([
      f.recovery.recover(f.user.id, f.record.id, input),
      f.recovery.recover(f.user.id, f.record.id, input),
    ]);
    expect(reissues.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = await db.prisma.personalRecord.findUniqueOrThrow({
      where: { id: f.record.id },
    });
    const details = objectValue(current.details);
    expect(details.recoveryHistory).toHaveLength(2);
    expect((details.recoveryHistory as unknown[])[0]).toEqual(originalTicket);
    expect(objectValue(details.recoveryTicket).supersedesRevision).toBe(originalTicket.revision);
    expect(details.preview).toBeUndefined();
    await f.prepare();
    expect((await f.campaigns.next(f.user.id, f.target.id, "synthetic")).status).toBe("task");
  });

  it("an earlier start using a stale manifest loses to transfer invalidation", async () => {
    const f = await recoveryTransferFixture(db);
    await f.prepare();
    const input = await f.recoverInput();
    const start = () =>
      db.service.start(f.user.id, {
        ...f.baseInput,
        campaignId: f.target.id,
        manifest: {
          ...f.baseInput.manifest,
          campaignRunId: f.target.authorization!.runId,
          campaignSnapshotHash: f.target.authorization!.snapshotHash,
        },
      });
    const raced = await Promise.allSettled([
      start(),
      f.recovery.recover(f.user.id, f.record.id, input),
    ]);
    expect(raced[0]!.status).toBe("rejected");
    expect(raced[1]!.status).toBe("fulfilled");
    await expect(start()).rejects.toThrow("Persisted eligibility, answers, document review");
    expect(await db.prisma.personalAttempt.count({ where: { recordId: f.record.id } })).toBe(1);
  });

  it.each([
    false,
    true,
  ])("an explicit original-campaign target remains run-bound and reissuable (via another campaign: %s)", async (viaAnotherCampaign) => {
    const f = await recoveryTransferFixture(db);
    if (viaAnotherCampaign) {
      await f.recovery.recover(f.user.id, f.record.id, await f.recoverInput());
      await f.campaigns.stop(f.user.id, f.target.id);
    }
    await f.campaigns.stop(f.user.id, f.original.id);
    await f.campaigns.launch(f.user.id, f.original.id, true);
    await f.refreshAnswers();
    await f.recovery.recover(f.user.id, f.record.id, await f.recoverInput(f.original.id));
    const before = await db.prisma.personalRecord.findUniqueOrThrow({
      where: { id: f.record.id },
    });
    const ticket = objectValue(objectValue(before.details).recoveryTicket);
    expect(ticket).toMatchObject({
      originalCampaignId: f.original.id,
      campaignId: f.original.id,
      targetCampaignId: f.original.id,
    });
    await f.prepare();
    await f.campaigns.stop(f.user.id, f.original.id);
    await f.campaigns.launch(f.user.id, f.original.id, true);
    const stale = await f.campaigns.next(f.user.id, f.original.id, "synthetic");
    expect(stale.status).toBe("idle");
    if (stale.status !== "idle") throw new Error("Explicit stale target unexpectedly selected");
    expect(stale.reasons).toContain(
      "Recovery transfer belongs to a different target campaign run.",
    );
    expect(await db.prisma.personalAttempt.count({ where: { recordId: f.record.id } })).toBe(1);
    await f.refreshAnswers();
    await f.recovery.recover(f.user.id, f.record.id, await f.recoverInput(f.original.id));
    const after = await db.prisma.personalRecord.findUniqueOrThrow({
      where: { id: f.record.id },
    });
    const details = objectValue(after.details);
    expect(details.recoveryHistory).toHaveLength(viaAnotherCampaign ? 3 : 2);
    expect((details.recoveryHistory as unknown[])[viaAnotherCampaign ? 1 : 0]).toEqual(ticket);
    expect(objectValue(details.recoveryTicket)).toMatchObject({
      targetCampaignId: f.original.id,
      supersedesRevision: ticket.revision,
    });
    await f.prepare();
    expect((await f.campaigns.next(f.user.id, f.original.id, "synthetic")).status).toBe("task");
  });

  it("does not reset true-failure retry lineage when selecting a new campaign", async () => {
    const f = await recoveryTransferFixture(db);
    await db.prisma.personalAttempt.createMany({
      data: [2, 3, 4].map((attemptNo) => ({
        userId: f.user.id,
        recordId: f.record.id,
        campaignId: f.original.id,
        mode: "submit" as const,
        state: "failed" as const,
        attemptNo,
        manifest: f.attempt.manifest!,
        manifestHash: f.attempt.manifestHash,
        leaseOwner: `synthetic-failure-${attemptNo}`,
        leaseExpiresAt: new Date(0),
        policyDay: f.attempt.policyDay,
        startedAt: new Date(0),
      })),
    });
    const input = await f.recoverInput();
    await expect(f.recovery.recover(f.user.id, f.record.id, input)).rejects.toThrow(
      "True failure retry limit",
    );
    const view = await f.recovery.get(f.user.id, f.record.id, f.target.id);
    expect(view.recovery.failedAttempts).toBe(3);
    expect(view.recovery.retriesRemaining).toBe(0);
  });
});
