import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { personalRecoveryResponseSchema } from "@jobpilot/contracts/personal-recovery";
import { PersonalCampaignService } from "./campaign.service";
import { eligibilityContext } from "./eligibility-freshness";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { manifestHash } from "./persistence-policy";
import {
  approvePersonalFixture,
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalRecoveryService } from "./recovery.service";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal recovery PostgreSQL lifecycle", () => {
  let db: PersonalTestDatabase;
  let recovery: PersonalRecoveryService;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
    recovery = new PersonalRecoveryService(db.prisma);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function fixture(mode: "offline" | "submit" = "offline") {
    const f = await personalFixture(db, mode, 10);
    const settings = f.settings;
    const campaigns = new PersonalCampaignService(
      db.prisma,
      { settings: async () => settings } as unknown as PersonalService,
      db.service,
    );
    const campaign = await campaigns.create(f.user.id, {
      name: "Synthetic recovery",
      mode,
      sources: { boardTokens: ["synthetic"] },
      tracks: ["mba_internship"],
      fitThreshold: 50,
      dailyCap: 10,
      maxApplications: 10,
      timezone: "America/New_York",
    });
    const r = await f.record();
    const quote = "Candidates must have financial analysis experience.";
    const posting = {
      ...objectValue(objectValue(r.record.details).posting),
      descriptionText: `${quote} ${objectValue(objectValue(r.record.details).posting).descriptionText}`,
    };
    r.input.manifest.attachmentRequirements = {
      ...r.input.manifest.attachmentRequirements,
      postingContentHash: manifestHash(posting),
    };
    const evidence = await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: {
        details: {
          conflicts: [],
          manifest: { leaves: [{ pointer: "/experience/0/summary", value: "Financial analysis" }] },
        },
      },
    });
    await db.prisma.personalRecord.update({
      where: { id: r.record.id },
      data: {
        details: jsonValue({
          ...objectValue(r.record.details),
          fitScore: 90,
          posting,
          attachmentRequirements: r.input.manifest.attachmentRequirements,
          evaluation: {
            requirements: [
              {
                requirement: "Experience",
                evidence: quote,
                status: "unknown",
                candidateEvidence: null,
              },
            ],
          },
          eligibility: { decision: "unknown", reasons: [] },
        }),
      },
    });
    const manifestPath = join(dirname(f.artifactPath), `${r.record.id}.json`);
    const bytes = JSON.stringify({ ...r.input.manifest, previewMode: "offline", answers: [] });
    await writeFile(manifestPath, bytes);
    async function prepare() {
      const current = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { id: r.record.id },
      });
      await db.prisma.personalRecord.update({
        where: { id: r.record.id },
        data: {
          state: "prepared",
          details: jsonValue({
            ...objectValue(current.details),
            eligibilityContext: eligibilityContext(current, { settings, evidence }),
            document: {
              ...documentPipelineInputs("cbs-letter-times"),
              template: "cbs-letter-times",
              path: f.artifactPath,
              sha256: db.hash,
            },
            manifestPath,
            preview: {
              ...objectValue(objectValue(r.record.details).preview),
              manifestHash: sha256(bytes),
            },
          }),
        },
      });
    }
    async function adjudicate() {
      const current = await recovery.get(f.user.id, r.record.id);
      return recovery.adjudicate(f.user.id, r.record.id, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
        context: current.context,
        decisions: [
          {
            requirementId: current.requirements[0]!.id,
            status: "satisfied",
            rationale: "Prior financial analysis responsibility is cited exactly",
            sourceQuote: quote,
            citation: {
              kind: "resume",
              pointer: "/experience/0/summary",
              value: "Financial analysis",
            },
          },
        ],
      });
    }
    async function next() {
      if (mode === "submit") await approvePersonalFixture(db, f.user.id, r.record.id, campaign.id);
      const task = await campaigns.next(f.user.id, campaign.id, "synthetic-supervisor");
      if (task.status !== "task") throw new Error(`No synthetic task: ${task.reasons.join("; ")}`);
      return task;
    }
    return { ...f, ...r, campaign, campaigns, prepare, adjudicate, next };
  }
  it("adjudicates before launch, preserves history, invalidates drafts, and rejects stale or foreign writes", async () => {
    const f = await fixture();
    const before = await recovery.get(f.user.id, f.record.id);
    const reviewed = await f.adjudicate();
    expect(personalRecoveryResponseSchema.safeParse(reviewed).success).toBe(true);
    expect(reviewed.eligibility).toBe("eligible");
    expect(reviewed.recovery.allowed).toBe(false);
    expect(reviewed.history).toHaveLength(1);
    const saved = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    expect(objectValue(saved.details).preview).toBeUndefined();
    expect(objectValue(objectValue(saved.details).evaluation).requirements).toMatchObject([
      { status: "unknown" },
    ]);
    await expect(
      recovery.adjudicate(f.user.id, f.record.id, {
        expectedUpdatedAt: before.updatedAt.toISOString(),
        context: before.context,
        decisions: [],
      }),
    ).rejects.toThrow("Record changed");
    await expect(recovery.get(crypto.randomUUID(), f.record.id)).rejects.toThrow("not found");
    await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: { details: { changed: true } },
    });
    expect((await recovery.get(f.user.id, f.record.id)).eligibility).toBe("unknown");
  });
  it("resolves a stopped campaign block without launching it and consumes one ticket when resumed", async () => {
    const f = await fixture();
    await f.prepare();
    const launched = await f.campaigns.launch(f.user.id, f.campaign.id, true);
    const first = await f.next();
    await db.service.park(
      f.user.id,
      first.attempt.id,
      first.attempt,
      "blocked",
      "Eligibility requires source review",
    );
    await f.campaigns.stop(f.user.id, f.campaign.id);
    const reviewed = await f.adjudicate();
    const resolved = await recovery.recover(f.user.id, f.record.id, {
      expectedUpdatedAt: reviewed.updatedAt.toISOString(),
      context: reviewed.context,
      attemptId: first.attempt.id,
      campaignRunId: launched.authorization!.runId,
      reason: "The exact qualification evidence has been reviewed",
      proof: { kind: "eligibility", adjudicationId: reviewed.history[0]!.id },
    });
    expect(resolved.recovery.allowed).toBe(false);
    expect(
      (await db.prisma.campaign.findUniqueOrThrow({ where: { campaignId: f.campaign.id } })).status,
    ).toBe("paused");
    expect(
      objectValue(
        (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } })).details,
      ).recoveryHistory,
    ).toHaveLength(1);
    expect((await f.campaigns.next(f.user.id, f.campaign.id, "supervisor")).status).toBe("idle");
    await f.campaigns.launch(f.user.id, f.campaign.id, true);
    await f.prepare();
    const resumed = await f.next();
    expect(resumed.attempt.id).not.toBe(first.attempt.id);
    expect(
      objectValue((await db.service.get(f.user.id, resumed.attempt.id)).manifest).recoveryRevision,
    ).toBeString();
  });
  it("recovers low-fit and unscored qualified roles without reintroducing a fit cutoff", async () => {
    for (const fitScore of [1, null]) {
      const f = await fixture();
      await f.prepare();
      const launched = await f.campaigns.launch(f.user.id, f.campaign.id, true);
      const first = await f.next();
      await db.service.park(
        f.user.id,
        first.attempt.id,
        first.attempt,
        "blocked",
        "Eligibility needs exact evidence",
      );
      await f.adjudicate();
      const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
      await db.prisma.personalRecord.update({
        where: { id: row.id },
        data: { details: jsonValue({ ...objectValue(row.details), fitScore }) },
      });
      const current = await recovery.get(f.user.id, row.id);
      expect(current.recovery.blockers).not.toContain(
        "Record is outside the campaign fit threshold",
      );
      expect(current.recovery.allowed).toBe(true);
      const recovered = await recovery.recover(f.user.id, row.id, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
        context: current.context,
        attemptId: first.attempt.id,
        campaignRunId: launched.authorization!.runId,
        reason: "The exact qualification evidence has been reviewed",
        proof: { kind: "eligibility", adjudicationId: current.history[0]!.id },
      });
      expect(recovered.eligibility).toBe("eligible");
      expect((await db.service.get(f.user.id, first.attempt.id)).state).toBe("blocked");
    }
  });
  it("permits resolved blocks repeatedly without spending true-failure retries and excludes consumed tickets", async () => {
    const f = await fixture();
    const launched = await f.campaigns.launch(f.user.id, f.campaign.id, true);
    for (let i = 0; i < 4; i++) {
      await f.prepare();
      const task = await f.next();
      if (i > 0)
        expect(
          objectValue((await db.service.get(f.user.id, task.attempt.id)).manifest).recoveryRevision,
        ).toBeString();
      await db.service.park(
        f.user.id,
        task.attempt.id,
        task.attempt,
        "blocked",
        "Eligibility requires source review",
      );
      expect((await f.campaigns.next(f.user.id, f.campaign.id, "supervisor")).status).toBe("idle");
      const reviewed = await f.adjudicate();
      await recovery.recover(f.user.id, f.record.id, {
        expectedUpdatedAt: reviewed.updatedAt.toISOString(),
        context: reviewed.context,
        attemptId: task.attempt.id,
        campaignRunId: launched.authorization!.runId,
        reason: "The exact qualification evidence has been reviewed",
        proof: { kind: "eligibility", adjudicationId: reviewed.history[0]!.id },
      });
    }
    expect((await recovery.get(f.user.id, f.record.id)).recovery.failedAttempts).toBe(0);
  });
  it("bounds true failures and never treats a security hold as a retryable failure", async () => {
    const f = await fixture();
    const launched = await f.campaigns.launch(f.user.id, f.campaign.id, true);
    for (let i = 0; i < 3; i++) {
      await f.prepare();
      const task = await f.next();
      await db.service.park(
        f.user.id,
        task.attempt.id,
        task.attempt,
        "failed",
        "Synthetic renderer process failed",
      );
      const current = await recovery.get(f.user.id, f.record.id);
      const work = recovery.recover(f.user.id, f.record.id, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
        context: current.context,
        attemptId: task.attempt.id,
        campaignRunId: launched.authorization!.runId,
        reason: "Retry the transient synthetic process failure",
        proof: { kind: "retry_failure" },
      });
      if (i < 2) await work;
      else await expect(work).rejects.toThrow("True failure retry limit");
    }
    const blocked = await fixture();
    await blocked.prepare();
    const launch = await blocked.campaigns.launch(blocked.user.id, blocked.campaign.id, true);
    const task = await blocked.next();
    await db.service.park(
      blocked.user.id,
      task.attempt.id,
      task.attempt,
      "failed",
      "Login verification challenge",
    );
    const current = await recovery.get(blocked.user.id, blocked.record.id);
    await expect(
      recovery.recover(blocked.user.id, blocked.record.id, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
        context: current.context,
        attemptId: task.attempt.id,
        campaignRunId: launch.authorization!.runId,
        reason: "Retry must not clear a browser challenge",
        proof: { kind: "retry_failure" },
      }),
    ).rejects.toThrow("server-verified");
  });
  it("requires server-verified browser proof and atomically accepts only one recovery revision", async () => {
    const f = await fixture();
    await f.prepare();
    const launch = await f.campaigns.launch(f.user.id, f.campaign.id, true);
    const task = await f.next();
    await db.service.park(f.user.id, task.attempt.id, task.attempt, "blocked", "Login challenge");
    let current = await recovery.get(f.user.id, f.record.id);
    const sessionId = crypto.randomUUID();
    const proof = { kind: "browser_session" as const, sessionId, sha256: db.hash };
    const input = () => ({
      expectedUpdatedAt: current.updatedAt.toISOString(),
      context: current.context,
      attemptId: task.attempt.id,
      campaignRunId: launch.authorization!.runId,
      reason: "An isolated browser session was verified by the server",
      proof,
    });
    await expect(recovery.recover(f.user.id, f.record.id, input())).rejects.toThrow(
      "server-verified",
    );
    const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    await db.prisma.personalRecord.update({
      where: { id: row.id },
      data: {
        details: jsonValue({
          ...objectValue(row.details),
          browserSessionEvidence: {
            sessionId,
            sha256: db.hash,
            postingContentHash: current.context.postingHash,
            verified: true,
            verifiedAt: new Date().toISOString(),
          },
        }),
      },
    });
    current = await recovery.get(f.user.id, f.record.id);
    await expect(
      recovery.recover(f.user.id, f.record.id, {
        ...input(),
        context: { ...current.context, sourceHash: "0".repeat(64) },
      }),
    ).rejects.toThrow("source context");
    const outcomes = await Promise.allSettled([
      recovery.recover(f.user.id, f.record.id, input()),
      recovery.recover(f.user.id, f.record.id, input()),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      objectValue(
        (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: row.id } })).details,
      ).recoveryHistory,
    ).toHaveLength(1);
  });
  it("keeps possible submissions held even after lease expiry", async () => {
    const f = await fixture("submit");
    await f.adjudicate();
    await f.prepare();
    await f.campaigns.launch(f.user.id, f.campaign.id, true);
    const task = await f.next();
    await db.service.beginSubmit(f.user.id, task.attempt.id, task.attempt);
    await db.prisma.personalAttempt.update({
      where: { id: task.attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await db.service.get(f.user.id, task.attempt.id);
    const current = await recovery.get(f.user.id, f.record.id);
    expect(current.recovery.allowed).toBe(false);
    await expect(f.adjudicate()).rejects.toThrow("reconciliation");
    expect(
      await db.prisma.personalReservation.count({ where: { attemptId: task.attempt.id } }),
    ).toBe(1);
  });
});
