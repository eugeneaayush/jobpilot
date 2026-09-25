import { CampaignService } from "@/modules/campaign/campaign.service";
import { PersonalAttemptService } from "./attempt.service";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Explicit opt-in only: the normal test suite never connects to DATABASE_URL.
const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal attempt PostgreSQL invariants", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("serializes competing reservations and fences expired workers", async () => {
    const f = await personalFixture(db, "offline");
    const { input } = await f.record();
    const results = await Promise.allSettled([
      db.service.start(f.user.id, input),
      db.service.start(f.user.id, { ...input, leaseOwner: "racer" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No reservation won");
    const lease = {
      leaseOwner: winner.value.leaseOwner,
      leaseGeneration: winner.value.leaseGeneration,
    };
    await db.prisma.personalAttempt.update({
      where: { id: winner.value.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const next = await db.service.start(f.user.id, { ...input, leaseOwner: "replacement" });
    expect(next.attemptNo).toBe(2);
    await expect(db.service.prepare(f.user.id, winner.value.id, lease)).rejects.toThrow(
      "Lease is stale",
    );
    await expect(
      db.service.beginSubmit(f.user.id, next.id, {
        leaseOwner: next.leaseOwner,
        leaseGeneration: next.leaseGeneration,
      }),
    ).rejects.toThrow("prepared submit attempt");
  });

  it("reserves a shared daily cap atomically across different jobs", async () => {
    const f = await personalFixture(db, "submit", 1);
    const first = await f.record();
    const second = await f.record();
    const results = await Promise.allSettled([
      db.service.start(f.user.id, first.input),
      db.service.start(f.user.id, second.input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(1);
  });

  it("requires persisted readiness even when the caller claims ready", async () => {
    const f = await personalFixture(db);
    const { record, input } = await f.record();
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: { details: { ...(record.details as object), eligibility: { decision: "unknown" } } },
    });
    await expect(db.service.start(f.user.id, input)).rejects.toThrow("Persisted eligibility");
    const previewCampaign = await db.prisma.campaign.create({
      data: {
        userId: f.user.id,
        source: "apply",
        query: "preview",
        config: {
          personal: {
            enabled: true,
            mode: "offline",
            dailyCap: 1,
            maxApplications: 1,
            timezone: "UTC",
            policyVersion: "test",
          },
        },
      },
    });
    expect(
      (
        await db.service.start(f.user.id, {
          ...input,
          mode: "offline",
          campaignId: previewCampaign.campaignId,
        })
      ).state,
    ).toBe("preparing");
  });

  it("rejects mutations to the manifest at the database boundary", async () => {
    const f = await personalFixture(db, "offline");
    const { input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    await expect(
      Promise.resolve(
        db.prisma.personalAttempt.update({
          where: { id: attempt.id },
          data: { manifest: { forged: true } },
        }),
      ),
    ).rejects.toThrow("immutable");
    await expect(
      Promise.resolve(
        db.prisma.personalAttempt.update({ where: { id: attempt.id }, data: { mode: "submit" } }),
      ),
    ).rejects.toThrow("immutable");
    expect((await db.service.get(f.user.id, attempt.id)).manifestHash).toBe(attempt.manifestHash);
  });

  it("preserves a crash after begin-submit across service restart, timeouts and campaign deletion", async () => {
    const f = await personalFixture(db);
    const { input, record } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const lease = { leaseOwner: attempt.leaseOwner, leaseGeneration: attempt.leaseGeneration };
    await db.service.prepare(f.user.id, attempt.id, lease);
    await db.service.beginSubmit(f.user.id, attempt.id, lease);
    await expect(db.service.beginSubmit(f.user.id, attempt.id, lease)).rejects.toThrow(
      "never retried automatically",
    );
    await db.prisma.personalAttempt.update({
      where: { id: attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await db.prisma.campaign.delete({ where: { campaignId: f.campaign.campaignId } });
    const restarted = new PersonalAttemptService(db.prisma);
    expect((await restarted.get(f.user.id, attempt.id)).state).toBe("submission_uncertain");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
    await expect(
      Promise.resolve(
        db.prisma.personalReservation.deleteMany({ where: { attemptId: attempt.id } }),
      ),
    ).rejects.toThrow("Resolve the submission");
    await expect(
      Promise.resolve(db.prisma.personalRecord.delete({ where: { id: record.id } })),
    ).rejects.toThrow();
    await expect(restarted.cancel(f.user.id, attempt.id, lease)).rejects.toThrow();
    const evidence = {
      outcome: "submitted" as const,
      kind: "confirmation_page" as const,
      artifactPath: f.artifactPath,
      sha256: db.hash,
      sourceUrl: record.url,
      capturedAt: new Date().toISOString(),
      details: "Synthetic receipt for test",
      manifestHash: attempt.manifestHash,
      externalReference: "TEST-42",
    };
    const confirmed = await restarted.reconcile(f.user.id, attempt.id, evidence);
    expect(confirmed.state).toBe("submitted");
    expect(confirmed.campaignId).toBe(f.campaign.campaignId);
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
  });

  it("releases only with hashed evidence of non-submission and rejects stale or foreign workers", async () => {
    const f = await personalFixture(db);
    const other = await personalFixture(db);
    const { input, record } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const lease = { leaseOwner: attempt.leaseOwner, leaseGeneration: attempt.leaseGeneration };
    await expect(db.service.get(other.user.id, attempt.id)).rejects.toThrow("not found");
    await expect(
      db.service.prepare(f.user.id, attempt.id, { ...lease, leaseGeneration: 999 }),
    ).rejects.toThrow("Lease is stale");
    await db.service.prepare(f.user.id, attempt.id, lease);
    await db.service.beginSubmit(f.user.id, attempt.id, lease);
    const evidence = {
      outcome: "not_submitted" as const,
      kind: "ats_status" as const,
      artifactPath: f.artifactPath,
      sha256: db.hash,
      sourceUrl: record.url,
      capturedAt: new Date().toISOString(),
      details: "Employer status confirms no application",
      manifestHash: attempt.manifestHash,
    };
    await expect(
      db.service.reconcile(f.user.id, attempt.id, { ...evidence, sha256: "0".repeat(64) }),
    ).rejects.toThrow("SHA256");
    expect((await db.service.reconcile(f.user.id, attempt.id, evidence)).state).toBe("cancelled");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(
      (await db.service.start(f.user.id, { ...input, leaseOwner: "new worker" })).attemptNo,
    ).toBe(2);
  });
  it("keeps applications and activity when a campaign is removed through its service", async () => {
    const f = await personalFixture(db, "offline");
    const application = await db.prisma.application.create({
      data: {
        userId: f.user.id,
        campaignId: f.campaign.campaignId,
        title: "Historical job",
        company: "Synthetic Employer",
        url: "https://example.test/historical",
        source: "apply",
        events: { create: { kind: "status_change", toStatus: "applied" } },
      },
    });
    await new CampaignService(db.prisma).remove(f.user.id, f.campaign.campaignId);
    expect(await db.prisma.application.findUnique({ where: { id: application.id } })).toMatchObject(
      { campaignId: null, userId: f.user.id },
    );
    expect(
      await db.prisma.applicationEvent.count({ where: { applicationId: application.id } }),
    ).toBe(1);
  });
  it("counts unresolved submissions from prior days against today's cap", async () => {
    const f = await personalFixture(db, "submit", 1);
    const historical = await f.record();
    await db.prisma.personalAttempt.create({
      data: {
        userId: f.user.id,
        recordId: historical.record.id,
        campaignId: f.campaign.campaignId,
        mode: "submit",
        state: "submission_uncertain",
        manifest: historical.input.manifest,
        manifestHash: db.hash,
        leaseOwner: "lost worker",
        leaseExpiresAt: new Date(0),
        submitAt: new Date("2000-01-01"),
        policyDay: "2000-01-01",
        attemptNo: 1,
      },
    });
    const fresh = await f.record();
    await expect(db.service.start(f.user.id, fresh.input)).rejects.toThrow("cap reached");
  });

  it("rechecks changed campaign policy and never submits a stale preparation", async () => {
    const f = await personalFixture(db);
    const { input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const lease = { leaseOwner: attempt.leaseOwner, leaseGeneration: attempt.leaseGeneration };
    await db.service.prepare(f.user.id, attempt.id, lease);
    await db.prisma.campaign.update({
      where: { campaignId: f.campaign.campaignId },
      data: { status: "paused" },
    });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, lease)).rejects.toThrow(
      "no longer active",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
  });
});
