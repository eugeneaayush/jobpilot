import "reflect-metadata";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import type { PersonalRecord, PrismaClient } from "@/generated/prisma/client";
import type { PersonalService } from "./personal.service";
import { PersonalReassessmentService } from "./reassessment.service";
import { describe, expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({
  mbaEnrolled: true,
  graduationYear: 2028,
  workAuthorization: true,
  workAuthorizationCountries: ["US"],
  targetFunctions: ["finance"],
});
function record(id: string, extra: Partial<PersonalRecord> = {}): PersonalRecord {
  return {
    id,
    userId: "owner",
    campaignId: null,
    jobId: null,
    identity: `synthetic:${id}`,
    title: "MBA Intern",
    company: "Synthetic",
    url: "https://example.test/job",
    requisitionId: id,
    state: "prepared",
    track: "mba_internship",
    createdAt: new Date(0),
    updatedAt: new Date(1),
    details: {
      posting: {
        descriptionText: "MBA students must be authorized to work in the US.",
        location: "New York",
        deadline: null,
      },
      evaluation: {
        requirements: [
          { requirement: "Old eligibility", status: "satisfied", evidence: "Old source" },
        ],
      },
      eligibilityAdjudication: { decisions: [{ status: "satisfied" }] },
      preview: { pdfHash: "old-pdf" },
      document: { path: "old.pdf" },
      manifestPath: "old.json",
      recoveryTicket: { revision: "old" },
      screeningAnswers: { snapshotHash: "saved-answer" },
      screeningAnswerSnapshots: [{ snapshotHash: "saved-answer" }],
      missingAnswers: ["Old eligibility", "Interview availability"],
    },
    ...extra,
  };
}
function harness(rows: PersonalRecord[], active = new Set<string>(), beforeLock?: () => void) {
  const evidence = { id: "resume-evidence", sourceHash: "source", details: {} };
  const prisma = {
    personalResumeEvidence: { findFirst: async () => evidence },
    personalRecord: {
      count: async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => row.userId === where.userId).length,
      findMany: async ({
        where,
        take,
      }: {
        where: { userId: string; id?: { gt?: string } };
        take: number;
      }) =>
        structuredClone(
          rows
            .filter((row) => row.userId === where.userId && (!where.id?.gt || row.id > where.id.gt))
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, take),
        ),
      findFirst: async ({ where }: { where: { id?: string; userId: string } }) =>
        rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; userId: string; updatedAt: Date };
        data: Partial<PersonalRecord>;
      }) => {
        const row = rows.find(
          (item) =>
            item.id === where.id &&
            item.userId === where.userId &&
            item.updatedAt.getTime() === where.updatedAt.getTime(),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
        return { count: 1 };
      },
    },
    personalAttempt: {
      findFirst: async ({ where }: { where: { recordId: string } }) =>
        active.has(where.recordId) ? { id: "active" } : null,
    },
    $queryRaw: async () => [{ id: "owner" }],
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      beforeLock?.();
      return work(prisma);
    },
  };
  const personal = {
    settings: async () => settings,
    resumeData: async () => ({
      data: {
        ...EMPTY_RESUME_DATA,
        summary: "Finance",
        skills: [{ category: "Financial", items: ["finance"] }],
      },
      evidence,
    }),
  };
  return {
    service: new PersonalReassessmentService(
      prisma as unknown as PrismaClient,
      personal as unknown as PersonalService,
    ),
    rows,
    personal,
  };
}

describe("offline reassessment of existing snapshots", () => {
  test("archives current readiness and adjudication while preserving answer history", async () => {
    const h = harness([record("a")]);
    expect(await h.service.reassess("owner")).toEqual({ evaluated: 1, skipped: 0 });
    const details = h.rows[0]!.details as Record<string, unknown>;
    expect(details.preview).toBeUndefined();
    expect(details.document).toBeUndefined();
    expect(details.manifestPath).toBeUndefined();
    expect(details.eligibilityAdjudication).toBeUndefined();
    expect(details.recoveryTicket).toBeUndefined();
    expect(details.reassessmentHistory).toMatchObject([
      {
        preview: { pdfHash: "old-pdf" },
        document: { path: "old.pdf" },
        manifestPath: "old.json",
        eligibilityAdjudication: { decisions: [{ status: "satisfied" }] },
      },
    ]);
    expect(details.screeningAnswers).toEqual({ snapshotHash: "saved-answer" });
    expect(details.screeningAnswerSnapshots).toEqual([{ snapshotHash: "saved-answer" }]);
    expect(details.resumeEvidenceId).toBe("resume-evidence");
    expect(details.missingAnswers).toContain("Interview availability");
    expect(details.missingAnswers).not.toContain("Old eligibility");
  });
  test("recomputes the undergraduate hold from the immutable posting", async () => {
    const h = harness([
      record("a", {
        title: "Business Analyst Intern",
        details: {
          posting: {
            descriptionText: "Candidates must be undergraduate students graduating in 2028.",
            location: "New York",
          },
          eligibility: { decision: "eligible" },
        },
      }),
    ]);
    await h.service.reassess("owner");
    expect(h.rows[0]!.state).toBe("discovered");
    expect(h.rows[0]!.details).toMatchObject({
      evaluation: { seniority: { classification: "undergraduate_entry" } },
      eligibility: { decision: "unknown" },
    });
  });
  test("never edits another user's records", async () => {
    const foreign = record("foreign", { userId: "another-owner" });
    const h = harness([record("a"), foreign]);
    const oldForeign = structuredClone(foreign);
    expect(await h.service.reassess("owner")).toEqual({ evaluated: 1, skipped: 0 });
    expect(foreign).toEqual(oldForeign);
  });
  test("skips submission-bound records and active attempts", async () => {
    const h = harness(
      [
        record("a", { state: "submitted" }),
        record("b", { state: "applying" }),
        record("c", { state: "submission_uncertain" }),
        record("d"),
      ],
      new Set(["d"]),
    );
    const before = structuredClone(h.rows);
    expect(await h.service.reassess("owner")).toEqual({ evaluated: 0, skipped: 4 });
    expect(h.rows).toEqual(before);
  });
  test("does not overwrite a concurrent record update", async () => {
    const current = record("a");
    const h = harness([current], new Set(), () => {
      current.updatedAt = new Date(2);
      current.details = { newAnswer: "saved concurrently" };
    });
    expect(await h.service.reassess("owner")).toEqual({ evaluated: 0, skipped: 1 });
    expect(current.details).toEqual({ newAnswer: "saved concurrently" });
  });
  test("walks more than one page without changing records twice", async () => {
    const h = harness(
      Array.from({ length: 105 }, (_, index) => record(String(index).padStart(3, "0"))),
    );
    expect(await h.service.reassess("owner")).toEqual({ evaluated: 105, skipped: 0 });
    for (const row of h.rows)
      expect((row.details as Record<string, unknown>).reassessmentHistory).toHaveLength(1);
  });
  test("appends newly configured constraints instead of retaining old eligibility approval", async () => {
    const h = harness([record("a")]);
    h.personal.settings = async () =>
      personalSettingsSchema.parse({
        ...settings,
        recruitingAvailability: {
          partTimeNow: true,
          partTimeMaxHours: 20,
          partTimeLocations: ["NYC", "US remote"],
          internshipStartMonth: "2027-05",
          internshipEndMonth: "2027-09",
          permanentStartMonth: "2028-05",
          paidOnly: true,
          englishSufficientOnly: true,
          employerSupportedInternational: true,
          unrestrictedTravelRelocation: true,
        },
      });
    await h.service.reassess("owner");
    const details = h.rows[0]!.details as Record<string, unknown>;
    expect(details.eligibility).toMatchObject({ decision: "unknown" });
    expect(details.recruitingConstraints).toMatchObject({ decision: "unknown" });
    expect(details.missingAnswers).toContain("Paid compensation");
    expect(details.eligibilityAdjudication).toBeUndefined();
  });
});
