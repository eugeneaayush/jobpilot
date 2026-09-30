import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PersonalDiscoveryService } from "../discovery.service";
import { objectValue } from "../runtime";
import { PersonalLeadsService } from "./leads.service";

export function leadFixture() {
  const userId = randomUUID();
  const campaignId = randomUUID();
  const runId = randomUUID();
  const policy = {
    name: "Synthetic leads",
    scheduler: "personal-campaign-v1",
    approvalPolicy: "per-application-v1",
    enabled: true,
    policyVersion: "1",
    mode: "offline",
    tracks: ["mba_internship"],
    sources: { boardTokens: ["example"] },
    fitThreshold: 0,
    dailyCap: 1,
    maxApplications: 1,
    timezone: "America/New_York",
    authorization: {
      runId,
      authorizedAt: new Date().toISOString(),
      settingsHash: "test",
      resumeEvidenceId: randomUUID(),
      sourceHash: "test",
      snapshotHash: "test",
      settings: {},
    },
  };
  const campaign = { campaignId, userId, status: "in_progress", config: { personal: policy } };
  const registry: { configuration: unknown } = {
    configuration: { source: "greenhouse", boardToken: "example", employer: "Example" },
  };
  const alias: { canonicalEmployer: string; evidence: unknown } = {
    canonicalEmployer: "domain:example.com",
    evidence: {
      schemaVersion: 1,
      verification: "owner_attested",
      ownerId: userId,
      attestedAt: new Date().toISOString(),
      officialDomain: "example.com",
      recordId: randomUUID(),
      postingContentHash: "a".repeat(64),
      sourceUrl: "https://example.com/careers",
      quote: "The official employer source is Example careers.",
      history: [],
    },
  };
  type Row = {
    id: string;
    userId: string;
    source: string;
    status: string;
    details: unknown;
    createdAt: Date;
  };
  const rows: Row[] = [];
  const calls: { operation: string; args: unknown }[] = [];
  let record: { id: string; identity: string; details: unknown } | null = null;
  const matches = (row: Row, where: Record<string, unknown>) => {
    if (where.userId && row.userId !== where.userId) return false;
    if (where.id && row.id !== where.id) return false;
    if (typeof where.source === "string" && row.source !== where.source) return false;
    const source = objectValue(where.source);
    if (source.startsWith && !row.source.startsWith(String(source.startsWith))) return false;
    const filter = objectValue(where.details);
    if (Array.isArray(filter.path)) {
      let value: unknown = row.details;
      for (const key of filter.path) value = objectValue(value)[String(key)];
      if (value !== filter.equals) return false;
    }
    return true;
  };
  const tx = {
    $queryRaw: async () => [{ id: userId }],
    campaign: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.userId === userId && where.campaignId === campaignId ? campaign : null,
    },
    personalSource: { findUnique: async () => registry },
    personalEmployerAlias: { findUnique: async () => alias },
    personalRecord: { findFirst: async () => record },
    personalDiscoveryRun: {
      create: async ({ data }: { data: Omit<Row, "createdAt" | "id"> & { id?: string } }) => {
        const row = { ...data, id: data.id ?? randomUUID(), createdAt: new Date() };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      findMany: async (args: { where: Record<string, unknown>; skip?: number; take?: number }) => {
        calls.push({ operation: "findMany", args });
        const results = rows.filter((row) => matches(row, args.where));
        return results.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? results.length));
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)).length,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row) throw new Error("Missing row");
        Object.assign(row, data);
        return row;
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  let discoverCount = 0;
  let emptyDescription = false;
  const discovery = {
    discover: async (_owner: string, input: unknown) => {
      discoverCount++;
      calls.push({ operation: "discover", args: input });
      const sourceRunId = randomUUID();
      record = {
        id: randomUUID(),
        identity: "greenhouse:example:42",
        details: {
          sourceRunId,
          posting: {
            nativeId: "42",
            descriptionText: emptyDescription ? "" : "Must be enrolled in an MBA.",
            contentHash: "b".repeat(64),
            url: "https://boards.greenhouse.io/example/jobs/42",
          },
        },
      };
      return { runId: sourceRunId, count: 1, status: "complete" };
    },
  } as unknown as PersonalDiscoveryService;
  return {
    userId,
    campaignId,
    runId,
    policy,
    campaign,
    registry,
    alias,
    rows,
    calls,
    prisma,
    tx,
    service: new PersonalLeadsService(prisma, discovery),
    discoverCount: () => discoverCount,
    setEmptyDescription: () => {
      emptyDescription = true;
    },
  };
}

export const syntheticLeadCandidate = {
  sourceRowId: "source-row-42",
  originalUrl: "https://boards.greenhouse.io/example/jobs/42?utm_source=feed",
  candidateDestinationUrl: "https://boards.greenhouse.io/example/jobs/42",
  titleHint: "MBA Intern",
  companyHint: "Example",
  locationHint: "New York",
  postedAt: null,
  sourceDateText: null,
};
