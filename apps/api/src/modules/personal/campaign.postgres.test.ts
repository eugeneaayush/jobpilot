import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { env } from "@/env";
import { PersonalCampaignService } from "./campaign.service";
import { eligibilityContext } from "./eligibility-freshness";
import { manifestHash } from "./persistence-policy";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalPreviewService } from "./preview.service";
import { PersonalReadinessService } from "./readiness.service";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal campaign PostgreSQL lifecycle", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function fixture(mode: "offline" | "submit" = "submit", dailyCap = 3) {
    const f = await personalFixture(db, mode, dailyCap);
    const settings = f.settings;
    const personal = { settings: async () => settings } as unknown as PersonalService;
    const service = new PersonalCampaignService(db.prisma, personal, db.service);
    const configured = await service.create(f.user.id, {
      name: "Synthetic campaign",
      mode,
      sources: { boardTokens: ["allowed"] },
      tracks: ["mba_internship"],
      fitThreshold: 70,
      dailyCap,
      maxApplications: 10,
      timezone: "America/New_York",
    });
    async function ready(overrides: Record<string, unknown> = {}, source = "allowed") {
      const r = await f.record();
      const identity = `greenhouse:${source}:${r.record.id}`;
      const posting = {
        source: "greenhouse",
        boardToken: source,
        nativeId: r.record.id,
        employer: r.record.company,
        descriptionText: String(objectValue(objectValue(r.record.details).posting).descriptionText),
        location: "New York, NY",
        url: r.record.url,
      };
      const questions = JSON.stringify({ id: r.record.id, questions: [] });
      const questionHash = sha256(questions);
      const questionPath = join(dirname(f.artifactPath), `${questionHash}.json`);
      await writeFile(questionPath, questions, { mode: 0o600 });
      const attachmentRequirements = {
        ...r.input.manifest.attachmentRequirements,
        identity,
        postingContentHash: manifestHash(posting),
        source: {
          ...r.input.manifest.attachmentRequirements.source,
          url: `https://boards-api.greenhouse.io/v1/boards/${source}/jobs/${r.record.id}?questions=true`,
          path: questionPath,
          sha256: questionHash,
          capturedAt: new Date().toISOString(),
        },
      };
      const previewAttachments = { attachmentRequirements, attachments: [] };
      const bytes = JSON.stringify({
        ...r.input.manifest,
        identity,
        postingContentHash: manifestHash(posting),
        ...previewAttachments,
        previewMode: "offline",
        answers: [],
      });
      const manifestPath = join(dirname(f.artifactPath), `${r.record.id}.json`);
      await writeFile(manifestPath, bytes);
      const updated = await db.prisma.personalRecord.update({
        where: { id: r.record.id },
        data: {
          identity,
          requisitionId: r.record.id,
          state: "prepared",
          details: {
            ...objectValue(r.record.details),
            posting,
            ...previewAttachments,
            previewAttachments,
            fitScore: 90,
            document: { path: f.artifactPath, sha256: db.hash },
            manifestPath,
            preview: {
              ...objectValue(objectValue(r.record.details).preview),
              manifestHash: sha256(bytes),
            },
            ...overrides,
          },
        },
      });
      return db.prisma.personalRecord.update({
        where: { id: updated.id },
        data: {
          details: jsonValue({
            ...objectValue(updated.details),
            eligibilityContext: eligibilityContext(updated, { settings, evidence: f.resume }),
          }),
        },
      });
    }
    return { ...f, configured, ready, service, settings };
  }

  it("creates stopped campaigns and excludes legacy or foreign campaigns from lists", async () => {
    const f = await fixture();
    expect(f.configured.status).toBe("stopped");
    expect(
      (await f.service.list(f.user.id, { page: 1, limit: 25 })).items.map((c) => c.id),
    ).toEqual([f.configured.id]);
    await expect(f.service.launch(f.user.id, f.configured.id, false)).rejects.toThrow("Explicit");
    const other = await fixture();
    await expect(f.service.stop(other.user.id, f.configured.id)).rejects.toThrow("not found");
    await expect(f.service.stop(f.user.id, f.campaign.campaignId)).rejects.toThrow(
      "not a configured",
    );
    expect(
      (await db.prisma.campaign.findUniqueOrThrow({ where: { campaignId: f.campaign.campaignId } }))
        .status,
    ).toBe("in_progress");
  });

  it("skips affected records and returns a scoped leased task without private paths", async () => {
    const f = await fixture();
    await f.ready({}, "outside");
    await f.ready({ missingAnswers: ["Work authorization"] });
    const lowFit = await f.ready({ fitScore: 5 });
    const ready = await f.ready();
    const launched = await f.service.launch(f.user.id, f.configured.id, true);
    expect(launched.authorization?.sourceHash).toBe(db.hash);
    const next = await f.service.next(f.user.id, f.configured.id, "supervisor");
    expect(next.status).toBe("task");
    if (next.status !== "task") throw new Error("No task");
    expect(next.record.id).toBe(ready.id);
    expect(next.attempt.state).toBe("prepared");
    expect(JSON.stringify(next)).not.toContain(dirname(f.artifactPath));
    const attempt = await db.service.get(f.user.id, next.attempt.id);
    expect(objectValue(attempt.manifest).answers).toEqual([]);
    const second = await f.service.next(f.user.id, f.configured.id, "second");
    expect(second.status).toBe("task");
    if (second.status === "task") expect(second.record.id).toBe(lowFit.id);
    expect((await f.service.next(f.user.id, f.configured.id, "third")).status).toBe("idle");
  });

  it("serializes simultaneous next calls under the daily cap", async () => {
    const f = await fixture("submit", 1);
    await f.ready();
    await f.ready();
    await f.service.launch(f.user.id, f.configured.id, true);
    const results = await Promise.all([
      f.service.next(f.user.id, f.configured.id, "one"),
      f.service.next(f.user.id, f.configured.id, "two"),
    ]);
    expect(results.filter((r) => r.status === "task")).toHaveLength(1);
    expect(results.filter((r) => r.status === "idle")).toHaveLength(1);
  });

  it("revokes pre-submit work and preserves post-submit uncertainty when stopped", async () => {
    const f = await fixture();
    await f.ready();
    await f.ready();
    await f.service.launch(f.user.id, f.configured.id, true);
    const first = await f.service.next(f.user.id, f.configured.id, "one");
    const second = await f.service.next(f.user.id, f.configured.id, "two");
    if (first.status !== "task" || second.status !== "task") throw new Error("Missing tasks");
    await db.service.beginSubmit(f.user.id, first.attempt.id, first.attempt);
    expect((await f.service.stop(f.user.id, f.configured.id)).status).toBe("stopped");
    expect((await db.service.get(f.user.id, first.attempt.id)).state).toBe("submission_uncertain");
    expect((await db.service.get(f.user.id, second.attempt.id)).state).toBe("cancelled");
    expect(
      await db.prisma.personalReservation.count({ where: { attemptId: first.attempt.id } }),
    ).toBe(1);
    expect(
      await db.prisma.personalReservation.count({ where: { attemptId: second.attempt.id } }),
    ).toBe(0);
    await expect(
      db.service.beginSubmit(f.user.id, second.attempt.id, second.attempt),
    ).rejects.toThrow("Lease is stale");
    expect((await f.service.next(f.user.id, f.configured.id, "third")).status).toBe("idle");
  });

  it("runs offline drafts under a bounded policy but refuses any submit transition", async () => {
    const f = await fixture("offline", 1);
    const record = await f.ready();
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: {
          ...objectValue(record.details),
          eligibility: { decision: "unknown" },
          preview: {
            ...objectValue(objectValue(record.details).preview),
            readiness: "draft",
            renderReviewed: false,
          },
        },
      },
    });
    await f.ready();
    await f.service.launch(f.user.id, f.configured.id, true);
    const first = await f.service.next(f.user.id, f.configured.id, "offline");
    if (first.status !== "task") throw new Error("No offline task");
    expect(first.task.kind).toBe("offline_preview");
    await expect(
      db.service.beginSubmit(f.user.id, first.attempt.id, first.attempt),
    ).rejects.toThrow("prepared submit");
    expect((await f.service.next(f.user.id, f.configured.id, "another")).status).toBe("idle");
    f.settings.locations.push("changed");
    const changed = await f.service.next(f.user.id, f.configured.id, "changed");
    expect(changed.status === "idle" && changed.reasons[0]).toContain("settings changed");
  });
  it("freezes screening citations with the exact preview bytes through scheduling", async () => {
    const f = await fixture("offline");
    const record = await f.ready();
    const original = {
      PERSONAL_MODE: env.PERSONAL_MODE,
      JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
    };
    env.PERSONAL_MODE = true;
    env.JOBPILOT_PERSONAL_ROOT = db.root;
    try {
      const answersService = new PersonalReadinessService(db.prisma);
      const saved = await answersService.saveAnswers(f.user.id, record.id, {
        expectedUpdatedAt: record.updatedAt.toISOString(),
        answers: [
          {
            key: "email",
            fieldName: "email",
            value: "synthetic@example.test",
            source: { kind: "explicit_user", confirmed: true },
          },
        ],
      });
      const previewPersonal = {
        settings: async () => f.settings,
        resumeData: async () => ({
          evidence: f.resume,
          resume: { id: f.resume.resumeId },
          data: { ...EMPTY_RESUME_DATA, basics: { name: "Synthetic Candidate" } },
        }),
      } as unknown as PersonalService;
      await new PersonalPreviewService(db.prisma, previewPersonal).preview(f.user.id, record.id);
      await f.service.launch(f.user.id, f.configured.id, true);
      const next = await f.service.next(f.user.id, f.configured.id, "real-preview-test");
      expect(next.status).toBe("task");
      if (next.status !== "task") throw new Error(next.reasons.join("; "));
      const attempt = await db.service.get(f.user.id, next.attempt.id);
      const manifest = objectValue(attempt.manifest);
      const document = objectValue(manifest.document);
      const bytes = await readFile(String(document.path));
      expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
      expect(sha256(bytes)).toBe(String(document.sha256));
      expect(manifest.answers).toEqual([
        { key: "email", fieldName: "email", value: "synthetic@example.test" },
      ]);
      expect(manifest.screeningAnswerSnapshotHash).toBe(saved.snapshot.snapshotHash);
      expect(objectValue(manifest.screeningAnswerSnapshot).answers).toEqual(saved.snapshot.answers);
      const frozenHash = attempt.manifestHash;
      await expect(
        answersService.saveAnswers(f.user.id, record.id, {
          expectedUpdatedAt: record.updatedAt.toISOString(),
          answers: [],
        }),
      ).rejects.toThrow();
      expect((await db.service.get(f.user.id, attempt.id)).manifestHash).toBe(frozenHash);
    } finally {
      Object.assign(env, original);
    }
  });
  it("replays a lost next response only for the same launch and lease owner", async () => {
    const f = await fixture("offline", 1);
    await f.ready();
    await f.service.launch(f.user.id, f.configured.id, true);
    const first = await f.service.next(f.user.id, f.configured.id, "durable-supervisor");
    if (first.status !== "task") throw new Error("No task");
    const replay = await f.service.next(f.user.id, f.configured.id, "durable-supervisor");
    expect(replay).toEqual(first);
    expect(await db.prisma.personalAttempt.count({ where: { campaignId: f.configured.id } })).toBe(
      1,
    );
    expect((await f.service.next(f.user.id, f.configured.id, "another-supervisor")).status).toBe(
      "idle",
    );
    const attempt = await db.service.get(f.user.id, first.attempt.id);
    expect(attempt.leaseExpiresAt.getTime() - attempt.startedAt.getTime()).toBeGreaterThan(88_000);
    expect(attempt.leaseExpiresAt.getTime() - attempt.startedAt.getTime()).toBeLessThan(91_000);
  });

  it("reclaims an expired preparation and its cap before scheduling a fresh lease", async () => {
    const f = await fixture("offline", 1);
    await f.ready();
    await f.service.launch(f.user.id, f.configured.id, true);
    const first = await f.service.next(f.user.id, f.configured.id, "lost-supervisor");
    if (first.status !== "task") throw new Error("No task");
    await db.prisma.personalAttempt.update({
      where: { id: first.attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const next = await f.service.next(f.user.id, f.configured.id, "replacement-supervisor");
    if (next.status !== "task") throw new Error(next.reasons.join("; "));
    expect(next.attempt.id).not.toBe(first.attempt.id);
    const expired = await db.service.get(f.user.id, first.attempt.id);
    expect(expired.state).toBe("cancelled");
    expect(expired.receipt).toMatchObject({ expiredPreparation: true });
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(1);
    await expect(db.service.prepare(f.user.id, first.attempt.id, first.attempt)).rejects.toThrow(
      "Lease is stale",
    );
  });

  it("revalidates immutable document bytes when replaying a prepared task", async () => {
    const f = await fixture("offline");
    await f.ready();
    await f.service.launch(f.user.id, f.configured.id, true);
    const first = await f.service.next(f.user.id, f.configured.id, "same-supervisor");
    expect(first.status).toBe("task");
    await writeFile(f.artifactPath, "Changed document bytes");
    await expect(f.service.next(f.user.id, f.configured.id, "same-supervisor")).rejects.toThrow(
      "SHA256",
    );
  });
});
