import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { PersonalCampaignService } from "./campaign.service";
import { PersonalDiscoveryService } from "./discovery.service";
import { eligibilityFreshness } from "./eligibility-freshness";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalPreparationService } from "./preparation.service";
import { preparationPreviewHash } from "./preparation-policy";
import type { PersonalPreviewService } from "./preview.service";
import { PersonalReassessmentService } from "./reassessment.service";
import { jsonValue, objectValue, readSettings } from "./runtime";
import type { PersonalTailoringService } from "./tailoring.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

describe.skipIf(!process.env.PERSONAL_TEST_DATABASE_URL)(
  "bounded stale eligibility refresh",
  () => {
    let db: PersonalTestDatabase;
    beforeAll(async () => {
      db = await createPersonalTestDatabase(process.env.PERSONAL_TEST_DATABASE_URL!);
    }, 30000);
    afterAll(async () => {
      if (db) await db.dispose();
    });
    async function fixture() {
      const f = await personalFixture(db, "offline", 10);
      f.settings.mbaEnrolled = true;
      f.settings.graduationYear = 2028;
      const saveSettings = () =>
        writeFile(join(db.root, "settings", `${f.user.id}.json`), JSON.stringify(f.settings));
      await saveSettings();
      const personal = {
        settings: readSettings,
        resumeData: async () => ({
          data: EMPTY_RESUME_DATA,
          evidence: await db.prisma.personalResumeEvidence.findUniqueOrThrow({
            where: { id: f.resume.id },
          }),
        }),
      } as unknown as PersonalService;
      const reassessment = new PersonalReassessmentService(db.prisma, personal);
      const campaigns = new PersonalCampaignService(db.prisma, personal, db.service);
      const configured = await campaigns.create(f.user.id, {
        name: "Synthetic freshness",
        mode: "offline",
        sources: { boardTokens: ["synthetic"] },
        tracks: ["mba_internship"],
        fitThreshold: 0,
        dailyCap: 10,
        maxApplications: 10,
        timezone: "America/New_York",
      });
      const campaign = await campaigns.launch(f.user.id, configured.id, true);
      const saved = (id: string) => db.prisma.personalRecord.findUniqueOrThrow({ where: { id } });
      return { ...f, personal, reassessment, campaigns, campaign, saveSettings, saved };
    }

    test("unchanged previews, history, timestamps and blocked states are a true no-op", async () => {
      const f = await fixture();
      const { record } = await f.record();
      const before = await f.saved(record.id);
      expect(await f.reassessment.refreshStale(f.user.id, [record.id])).toEqual({
        evaluated: 0,
        skipped: 1,
      });
      expect(await f.saved(record.id)).toEqual(before);
      expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(0);
    });

    test("settings authorization holds first; relaunch refreshes stale records before track filtering", async () => {
      const f = await fixture();
      const { record } = await f.record();
      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: {
          track: "general_professional",
          details: jsonValue({
            ...objectValue(record.details),
            posting: {
              ...objectValue(objectValue(record.details).posting),
              descriptionText:
                "Candidates must be currently enrolled in an MBA program. This paid internship runs from June 2027 to August 2027.",
            },
          }),
        },
      });

      f.settings.mbaEnrolled = false;
      await f.saveSettings();
      const before = await f.saved(record.id);
      const held = await f.campaigns.next(f.user.id, f.campaign.id, "synthetic");
      expect(held.status).toBe("idle");
      if (held.status !== "idle") throw new Error("Expected authorization hold");
      expect(held.reasons.join(" ")).toContain("settings changed");
      expect(await f.saved(record.id)).toEqual(before);
      await f.campaigns.stop(f.user.id, f.campaign.id);
      await f.campaigns.launch(f.user.id, f.campaign.id, true);
      expect((await f.campaigns.next(f.user.id, f.campaign.id, "synthetic")).status).toBe("idle");
      const after = await f.saved(record.id);
      expect(after.track).toBe("mba_internship");
      expect(objectValue(after.details).eligibility).toMatchObject({ decision: "ineligible" });
      expect(eligibilityFreshness(after, { settings: f.settings, evidence: f.resume }).status).toBe(
        "current",
      );
      expect(objectValue(after.details).preview).toBeUndefined();
    });

    test("initial context stamping preserves a legacy preview whose full preparation inputs are still current", async () => {
      const f = await fixture();
      const { record } = await f.record();
      await f.reassessment.reassess(f.user.id);
      const current = await f.saved(record.id);
      const details = objectValue(current.details);
      delete details.eligibilityContext;
      const preview = {
        preparationContextHash: preparationPreviewHash(
          current,
          f.settings,
          f.resume,
          EMPTY_RESUME_DATA,
        ),
        pdfHash: db.hash,
        renderReviewed: true,
      };
      const document = { path: f.artifactPath, sha256: db.hash };
      await db.prisma.personalRecord.update({
        where: { id: current.id },
        data: {
          state: "prepared",
          details: jsonValue({ ...details, preview, document, manifestPath: "synthetic.json" }),
        },
      });
      expect(await f.reassessment.refreshStale(f.user.id, [record.id])).toEqual({
        evaluated: 1,
        skipped: 0,
      });
      const stamped = await f.saved(record.id);
      expect(stamped.state).toBe("prepared");
      expect(objectValue(stamped.details).preview).toEqual(preview);
      expect(objectValue(stamped.details).document).toEqual(document);
      expect(objectValue(stamped.details).manifestPath).toBe("synthetic.json");
      expect(await f.reassessment.refreshStale(f.user.id, [record.id])).toEqual({
        evaluated: 0,
        skipped: 1,
      });
      expect(await f.saved(record.id)).toEqual(stamped);
    });

    test("one poll refreshes at most 25 source-scoped records and later polls progress", async () => {
      const f = await fixture();
      const records = await Promise.all(Array.from({ length: 26 }, () => f.record()));
      const other = await f.record();
      const outside = await db.prisma.personalRecord.update({
        where: { id: other.record.id },
        data: { identity: "greenhouse:outside:1" },
      });
      f.settings.requiresSponsorship = false;
      await f.saveSettings();
      await f.campaigns.stop(f.user.id, f.campaign.id);
      await f.campaigns.launch(f.user.id, f.campaign.id, true);
      await f.campaigns.next(f.user.id, f.campaign.id, "synthetic");
      const first = await Promise.all(records.map(({ record }) => f.saved(record.id)));
      expect(
        first.filter(
          (row) =>
            eligibilityFreshness(row, { settings: f.settings, evidence: f.resume }).status ===
            "current",
        ),
      ).toHaveLength(25);
      await f.campaigns.next(f.user.id, f.campaign.id, "synthetic");
      const second = await Promise.all(records.map(({ record }) => f.saved(record.id)));
      expect(
        second.every(
          (row) =>
            eligibilityFreshness(row, { settings: f.settings, evidence: f.resume }).status ===
            "current",
        ),
      ).toBe(true);
      for (const row of second)
        expect(objectValue(row.details).reassessmentHistory).toHaveLength(1);
      expect(await f.saved(outside.id)).toEqual(outside);
    });

    test.each([
      "claim",
      "attempt",
    ])("a prefix of 25 pinned %s records cannot starve later stale records", async (kind) => {
      const f = await fixture();
      const records = (await Promise.all(Array.from({ length: 26 }, () => f.record())))
        .map(({ record }) => record)
        .sort((a, b) => a.id.localeCompare(b.id));
      f.settings.requiresSponsorship = false;
      await f.saveSettings();
      await f.campaigns.stop(f.user.id, f.campaign.id);
      await f.campaigns.launch(f.user.id, f.campaign.id, true);
      const pinned = [];
      for (const record of records.slice(0, 25)) {
        if (kind === "claim") {
          await db.prisma.personalRecord.update({
            where: { id: record.id },
            data: {
              details: jsonValue({
                ...objectValue(record.details),
                preparation: {
                  status: "running",
                  leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
                  claimId: crypto.randomUUID(),
                },
              }),
            },
          });
        } else {
          await db.prisma.personalAttempt.create({
            data: {
              recordId: record.id,
              userId: f.user.id,
              campaignId: f.campaign.id,
              mode: "offline",
              state: "prepared",
              manifest: { synthetic: true },
              manifestHash: db.hash,
              leaseOwner: "synthetic",
              leaseExpiresAt: new Date(Date.now() + 60000),
              attemptNo: 1,
              policyDay: "2026-01-01",
            },
          });
        }
        pinned.push(await f.saved(record.id));
      }
      const attempts = await db.prisma.personalAttempt.findMany({ where: { userId: f.user.id } });
      await f.campaigns.next(f.user.id, f.campaign.id, "synthetic");
      const last = await f.saved(records.at(-1)!.id);
      expect(eligibilityFreshness(last, { settings: f.settings, evidence: f.resume }).status).toBe(
        "current",
      );
      expect(objectValue(last.details).reassessmentHistory).toHaveLength(1);
      for (const record of pinned) expect(await f.saved(record.id)).toEqual(record);
      expect(await db.prisma.personalAttempt.findMany({ where: { userId: f.user.id } })).toEqual(
        attempts,
      );
    });

    test("blocked retry lineage is immutable and active preparation or tailoring claims defer refresh", async () => {
      const f = await fixture();
      const blocked = await f.record();
      const attempt = await db.service.start(f.user.id, blocked.input);
      await db.service.park(f.user.id, attempt.id, attempt, "blocked", "Synthetic unknown answer");
      const history = await db.prisma.personalAttempt.findMany({
        where: { recordId: blocked.record.id },
      });
      const claims = await Promise.all(
        ["preparation", "tailoring"].map(async (key) => {
          const { record } = await f.record();
          return db.prisma.personalRecord.update({
            where: { id: record.id },
            data: {
              details: jsonValue({
                ...objectValue(record.details),
                [key]: {
                  status: "running",
                  leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
                  claimId: crypto.randomUUID(),
                },
              }),
            },
          });
        }),
      );
      f.settings.requiresSponsorship = false;
      await f.saveSettings();
      expect(
        await f.reassessment.refreshStale(f.user.id, [
          blocked.record.id,
          ...claims.map((row) => row.id),
        ]),
      ).toEqual({ evaluated: 1, skipped: 2 });
      expect((await f.saved(blocked.record.id)).state).toBe("blocked");
      expect(
        await db.prisma.personalAttempt.findMany({ where: { recordId: blocked.record.id } }),
      ).toEqual(history);
      for (const claim of claims) expect(await f.saved(claim.id)).toEqual(claim);
    });

    test("direct preparation rejects stale eligibility before any provider call", async () => {
      const f = await fixture();
      const { record } = await f.record();
      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: { title: "Changed MBA internship" },
      });
      const service = new PersonalPreparationService(
        db.prisma,
        f.personal,
        {} as PersonalTailoringService,
        {} as PersonalPreviewService,
      );
      await expect(service.advance(f.user.id, record.id, f.campaign.id)).rejects.toThrow(
        "Eligibility needs refresh",
      );
      expect(objectValue((await f.saved(record.id)).details).preparation).toBeUndefined();
    });

    test("CBS imports stamp current eligibility and preserve unchanged previews without employer requests", async () => {
      const f = await fixture();
      const discovery = new PersonalDiscoveryService(db.prisma, f.personal);
      const input = {
        source: "cbs" as const,
        boardToken: "synthetic-cbs",
        importFormat: "json" as const,
        sourceUrl: "https://example.test/export",
        importText: JSON.stringify([
          {
            id: "1",
            title: "MBA internship",
            employer: "Synthetic",
            url: "https://example.test/jobs/1",
            description:
              "MBA students required. This paid internship runs from June 2027 to August 2027.",
            location: "New York, NY",
          },
        ]),
      };
      await discovery.discover(f.user.id, input);
      const first = await db.prisma.personalRecord.findFirstOrThrow({
        where: { userId: f.user.id, identity: "cbs:synthetic-cbs:1" },
      });
      expect(eligibilityFreshness(first, { settings: f.settings, evidence: f.resume }).status).toBe(
        "current",
      );
      await db.prisma.personalRecord.update({
        where: { id: first.id },
        data: {
          details: jsonValue({
            ...objectValue(first.details),
            preview: { retained: "exact synthetic artifact" },
          }),
        },
      });
      await db.prisma.personalSource.updateMany({
        where: { userId: f.user.id },
        data: { nextEligibleAt: new Date(0) },
      });
      await discovery.discover(f.user.id, input);
      expect(objectValue((await f.saved(first.id)).details).preview).toEqual({
        retained: "exact synthetic artifact",
      });
      expect(f.settings.requiresSponsorship).toBeNull();
    });
  },
);
