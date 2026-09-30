import { randomUUID } from "node:crypto";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import type {
  PersonalDiscoveryRun,
  PersonalRecord,
  PilotQuestion,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { eligibilityContext } from "../eligibility-freshness";
import { manifestHash } from "../persistence-policy";
import type { PersonalService } from "../personal.service";
import type { PersonalPreparationService } from "../preparation.service";
import { preparationPreviewHash } from "../preparation-policy";
import { objectValue } from "../runtime";
import { buildTailoringInput } from "../tailoring/proposal";
import { PersonalBatchesService } from "./batches.service";

const jsonValue = (value: unknown): Prisma.JsonValue => JSON.parse(JSON.stringify(value));

export function batchFixture() {
  const userId = randomUUID();
  const campaignId = randomUUID();
  const runId = randomUUID();
  const settings = personalSettingsSchema.parse({
    targetFunctions: ["PE", "VC", "AI", "C++"],
    mbaEnrolled: true,
  });
  const data = {
    ...structuredClone(EMPTY_RESUME_DATA),
    basics: { name: "Synthetic Applicant" },
    summary: "PE VC AI",
  };
  const evidence = {
    id: randomUUID(),
    sourceHash: "a".repeat(64),
    details: { conflicts: [] },
    userId,
    resumeId: randomUUID(),
    createdAt: new Date(),
  };
  const policy = {
    name: "Batch test",
    scheduler: "personal-campaign-v1",
    approvalPolicy: "per-application-v1",
    enabled: true,
    policyVersion: "1",
    mode: "offline",
    tracks: ["mba_internship"],
    sources: { boardTokens: ["example"] },
    fitThreshold: 0,
    dailyCap: 1,
    maxApplications: 5,
    timezone: "America/New_York",
    authorization: {
      runId,
      authorizedAt: new Date().toISOString(),
      settingsHash: manifestHash(settings),
      resumeEvidenceId: evidence.id,
      sourceHash: evidence.sourceHash,
      snapshotHash: "b".repeat(64),
      settings,
    },
  };
  const campaign = { campaignId, userId, status: "in_progress", config: { personal: policy } };
  const records: PersonalRecord[] = Array.from({ length: 3 }, (_, index) => {
    const id = randomUUID();
    const posting = {
      source: "greenhouse",
      boardToken: "example",
      nativeId: String(index),
      title: "MBA investment internship",
      employer: "Example",
      descriptionText: "MBA internship. PE VC AI C++ preferred.",
      location: "New York",
      deadline: null,
      contentHash: "c".repeat(64),
      url: `https://boards.greenhouse.io/example/jobs/${index}`,
    };
    const record: PersonalRecord = {
      id,
      userId,
      identity: `greenhouse:example:${index}`,
      title: posting.title,
      company: "Example",
      track: "mba_internship",
      campaignId,
      jobId: null,
      requisitionId: String(index),
      url: posting.url,
      state: "eligible",
      details: jsonValue({
        posting,
        eligibility: { decision: "eligible" },
        resumeEvidenceId: evidence.id,
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    record.details = jsonValue({
      ...objectValue(record.details),
      eligibilityContext: eligibilityContext(record, { settings, evidence }),
    });
    return record;
  });
  const runs: PersonalDiscoveryRun[] = [];
  const questions: PilotQuestion[] = [];
  const calls: string[] = [];
  const fail = new Set<string>();
  const tx = {
    $queryRaw: async () => [{ id: userId }],
    campaign: { findFirst: async () => campaign },
    personalResumeEvidence: { findFirst: async () => evidence },
    personalRecord: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = objectValue(where.id).in;
        return records.filter(
          (record) =>
            record.userId === where.userId && (!Array.isArray(ids) || ids.includes(record.id)),
        );
      },
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        records.find((record) => record.id === where.id && record.userId === where.userId) ?? null,
      updateMany: async ({
        where,
        data: patch,
      }: {
        where: { id: string; updatedAt?: Date };
        data: { details: unknown };
      }) => {
        const record = records.find((item) => item.id === where.id);
        if (
          !record ||
          (where.updatedAt && record.updatedAt.getTime() !== where.updatedAt.getTime())
        )
          return { count: 0 };
        record.details = jsonValue(patch.details);
        record.updatedAt = new Date(record.updatedAt.getTime() + 1);
        return { count: 1 };
      },
    },
    personalDiscoveryRun: {
      create: async ({ data: row }: { data: Omit<PersonalDiscoveryRun, "createdAt"> }) => {
        const saved = { ...row, createdAt: new Date() };
        runs.push(saved);
        return saved;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        runs.find(
          (row) =>
            row.userId === where.userId &&
            (!where.id || row.id === where.id) &&
            (typeof where.source !== "string" || row.source === where.source),
        ) ?? null,
      findMany: async ({
        where,
        skip = 0,
        take = 25,
      }: {
        where: { userId: string };
        skip: number;
        take: number;
      }) => runs.filter((row) => row.userId === where.userId).slice(skip, skip + take),
      count: async ({ where }: { where: { userId: string } }) =>
        runs.filter((row) => row.userId === where.userId).length,
      update: async ({
        where,
        data: patch,
      }: {
        where: { id: string };
        data: { details: unknown };
      }) => {
        const row = runs.find((item) => item.id === where.id)!;
        row.details = jsonValue(patch.details);
        return row;
      },
    },
    pilotQuestion: {
      create: async ({
        data: question,
      }: {
        data: Pick<PilotQuestion, "userId" | "prompt" | "subjectType" | "subjectId">;
      }) => {
        const row: PilotQuestion = {
          ...question,
          id: randomUUID(),
          kind: "question",
          status: "open",
          answer: null,
          answeredAt: null,
          expiresAt: null,
          createdAt: new Date(),
          options: [],
          deepLink: "/personal",
        };
        questions.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Pick<PilotQuestion, "userId" | "subjectId"> }) =>
        questions.find(
          (question) => question.userId === where.userId && question.subjectId === where.subjectId,
        ) ?? null,
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const personal = {
    settings: async () => settings,
    resumeData: async () => ({ evidence, data }),
  } as unknown as PersonalService;
  const preparation = {
    advance: async (_owner: string, recordId: string) => {
      calls.push(recordId);
      if (fail.has(recordId)) throw new Error("Synthetic isolated member failure");
      return { status: "pending", phase: "claim_review", reason: null, nextEligibleAt: null };
    },
  } as unknown as PersonalPreparationService;
  const markComplete = (record: PersonalRecord) => {
    const details = objectValue(record.details);
    const posting = objectValue(details.posting);
    const input = buildTailoringInput(data, {
      sourceDigest: evidence.sourceHash,
      maxPages: 1,
      job: {
        identity: record.identity,
        title: record.title,
        company: record.company,
        description: String(posting.descriptionText),
        postingContentHash: String(posting.contentHash),
      },
    });
    record.details = jsonValue({
      ...details,
      tailoring: { status: "reviewed", input },
      document: { sha256: "d".repeat(64) },
      documentVerification: {
        status: "passed",
        verifierVersion: "1",
        artifactSha256: "d".repeat(64),
      },
      preview: {
        pdfHash: "d".repeat(64),
        renderReviewed: true,
        readiness: "ready",
        preparationContextHash: preparationPreviewHash(record, settings, evidence, data),
      },
    });
  };
  return {
    userId,
    campaignId,
    runId,
    settings,
    data,
    evidence,
    policy,
    campaign,
    records,
    runs,
    questions,
    calls,
    fail,
    prisma,
    personal,
    preparation,
    markComplete,
    service: new PersonalBatchesService(prisma, personal, preparation),
  };
}
