import "reflect-metadata";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@/env";
import type { PrismaClient } from "@/generated/prisma/client";
import { PersonalDigestService } from "./digest.service";
import { afterEach, expect, test } from "bun:test";

const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
const roots: string[] = [];
afterEach(async () => {
  Object.assign(env, original);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function harness(digest: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-digest-test-"));
  roots.push(root);
  env.PERSONAL_MODE = true;
  env.JOBPILOT_PERSONAL_ROOT = root;
  const userId = crypto.randomUUID();
  await writeFile(join(root, "runtime.json"), JSON.stringify({ account: { userId }, digest }), {
    mode: 0o600,
  });
  const records: {
    id: string;
    userId: string;
    title: string;
    company: string;
    state: string;
    details: unknown;
    createdAt: Date;
  }[] = [];
  const sources: {
    userId: string;
    identity: string;
    attemptedAt: Date | null;
    completedAt: Date | null;
    nextEligibleAt: Date | null;
    status: string | null;
    coverage: unknown;
  }[] = [];
  const campaigns: {
    userId: string;
    campaignId: string;
    query: string;
    status: string;
    config: unknown;
  }[] = [];
  let queries = 0;
  const own = <T extends { userId: string }>(rows: T[], where: { userId: string }) => {
    queries++;
    return rows.filter((row) => row.userId === where.userId);
  };
  const prisma = {
    personalRecord: {
      groupBy: async ({ where }: { where: { userId: string } }) => {
        const counts = new Map<string, number>();
        for (const row of own(records, where))
          counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
        return [...counts].map(([state, count]) => ({ state, _count: { _all: count } }));
      },
      count: async ({
        where,
      }: {
        where: {
          userId: string;
          state?: { not: string };
          createdAt?: { gt?: Date; gte?: Date; lte: Date };
        };
      }) =>
        own(records, where).filter((row) => {
          if (where.state) return row.state !== where.state.not;
          const range = where.createdAt!;
          return (
            row.createdAt <= range.lte &&
            (range.gt ? row.createdAt > range.gt : row.createdAt >= range.gte!)
          );
        }).length,
      findMany: async ({
        where,
        take,
      }: {
        where: { userId: string; state: { not: string } };
        take: number;
      }) =>
        own(records, where)
          .filter((row) => row.state !== where.state.not)
          .slice(0, take),
    },
    personalSource: {
      findMany: async ({ where, take }: { where: { userId: string }; take: number }) =>
        own(sources, where).slice(0, take),
    },
    campaign: {
      findMany: async ({ where, take }: { where: { userId: string }; take: number }) =>
        own(campaigns, where).slice(0, take),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  const record = (
    state = "discovered",
    createdAt = new Date("2026-09-16T12:00:00Z"),
    details: unknown = {},
  ) => {
    const row = {
      id: crypto.randomUUID(),
      userId,
      title: "Synthetic Role",
      company: "Fixture",
      state,
      createdAt,
      details,
    };
    records.push(row);
    return row;
  };
  return {
    root,
    userId,
    records,
    record,
    sources,
    campaigns,
    queries: () => queries,
    service: new PersonalDigestService(prisma as unknown as PrismaClient),
    restart: () => new PersonalDigestService(prisma as unknown as PrismaClient),
  };
}

test("default6pm NewYork schedule and read-only latest create no early artifacts", async () => {
  const f = await harness();
  expect(await f.service.latest(f.userId)).toBeNull();
  expect((await f.service.tick(f.userId, new Date("2026-09-16T21:59:59Z"))).status).toBe("not_due");
  expect(await readdir(f.root)).toEqual(["runtime.json"]);
  expect(f.queries()).toBe(0);
  expect((await f.service.tick(f.userId, new Date("2026-09-16T22:00:00Z"))).status).toBe("created");
});

test("concurrent ticks and restarted instances publish exactly one immutable daily pointer", async () => {
  const f = await harness();
  f.record();
  const now = new Date("2026-09-16T22:00:00Z");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.restart().tick(f.userId, now)),
  );
  expect(results.filter((item) => item.status === "created")).toHaveLength(1);
  expect(new Set(results.map((item) => item.digest?.sha256)).size).toBe(1);
  const directory = join(f.root, "storage", f.userId, "digests");
  expect((await readdir(directory)).sort()).toEqual(["2026-09-16.json", "snapshots"]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, "2026-09-16.json"))).mode & 0o777).toBe(0o600);
  const hash = results[0]!.digest!.sha256;
  const artifact = join(directory, "snapshots", `${hash}.json`);
  expect((await stat(artifact)).mode & 0o777).toBe(0o600);
  const before = await readFile(artifact, "utf8");
  f.record("submitted");
  expect((await f.restart().tick(f.userId, new Date("2026-09-17T03:59:59Z"))).status).toBe(
    "already_created",
  );
  expect((await f.restart().latest(f.userId))?.sha256).toBe(hash);
  expect(await readFile(artifact, "utf8")).toBe(before);
  expect((await f.service.tick(f.userId, new Date("2026-09-17T04:00:00Z"))).status).toBe("not_due");
});

for (const [first, second, hours] of [
  ["2026-03-07T23:00:00Z", "2026-03-08T22:00:00Z", 23],
  ["2026-10-31T22:00:00Z", "2026-11-01T23:00:00Z", 25],
] as const)
  test(`daily windows span ${hours} hours across NewYork DST`, async () => {
    const f = await harness();
    await f.service.tick(f.userId, new Date(first));
    f.record("discovered", new Date(Date.parse(first) + 1000));
    const result = await f.restart().tick(f.userId, new Date(second));
    expect(result.status).toBe("created");
    expect(result.digest!.capturedAt.getTime() - result.digest!.windowStartAt.getTime()).toBe(
      hours * 3_600_000,
    );
    expect(result.digest!.windowStartExclusive).toBe(true);
    expect(result.digest!.counters.newDiscoveries).toBe(1);
  });

test("counters distinguish new records from state totals; failed and unattempted sources never imply complete coverage", async () => {
  const f = await harness();
  f.record("discovered", new Date("2026-09-16T04:00:00Z"));
  f.record("prepared", new Date("2026-09-15T12:00:00Z"), {
    preview: { pdfHash: "hash", renderReviewed: false },
  });
  f.record("submitted", new Date("2026-09-15T12:00:00Z"));
  f.record("submission_uncertain");
  f.record("blocked", new Date("2026-09-16T12:00:00Z"), {
    missingAnswers: ["private-answer-canary"],
    handoff: { status: "parked", token: "private-token-canary" },
  });
  f.record("failed");
  f.records.push({ ...f.records[0]!, userId: crypto.randomUUID(), state: "submitted" });
  f.campaigns.push({
    userId: f.userId,
    campaignId: crypto.randomUUID(),
    query: "Paused search",
    status: "paused",
    config: {
      personal: {
        scheduler: "personal-campaign-v1",
        sources: { boardTokens: ["complete", "failed", "new"] },
        enabled: false,
      },
    },
  });
  for (const [identity, status, completedAt] of [
    ["greenhouse:complete", "complete", "2026-09-16T20:00:00Z"],
    ["greenhouse:failed", "failed", "2026-09-15T00:00:00Z"],
    ["ashby:old", "complete", "2026-09-13T20:00:00Z"],
  ])
    f.sources.push({
      userId: f.userId,
      identity: identity!,
      status: status!,
      attemptedAt: new Date("2026-09-16T20:00:00Z"),
      completedAt: new Date(completedAt!),
      nextEligibleAt: new Date("2026-09-17T00:00:00Z"),
      coverage: { count: 2, expectedTotal: 20, errors: ["private-error-canary"] },
    });
  const digest = (await f.service.tick(f.userId, new Date("2026-09-16T22:00:00Z"))).digest!;
  expect(digest.counters).toEqual({
    newDiscoveries: 4,
    prepared: 1,
    submitted: 1,
    uncertain: 1,
    blocked: 1,
    failed: 1,
  });
  expect(digest.counterBasis).toContain("not daily transitions");
  expect(digest.sourceCoverage.wholeMarketCoverage).toBe(false);
  expect(digest.sourceCoverage.sources.map((source) => [source.identity, source.health])).toEqual([
    ["ashby:old", "stale"],
    ["greenhouse:complete", "complete"],
    ["greenhouse:failed", "failed"],
    ["greenhouse:new", "never_attempted"],
  ]);
  expect(digest.stoppedCampaigns).toHaveLength(1);
  expect(digest.blockers.flatMap((item) => item.kinds)).toContain("reconcile_submission");
  expect(digest.blockers.flatMap((item) => item.kinds)).toContain("security_handoff");
  expect(JSON.stringify(digest)).not.toContain("private-");
  expect(digest.delivery).toBe("local_only");
});

test("foreign users, corrupt snapshots and symlinked artifact directories fail closed", async () => {
  const f = await harness();
  await expect(f.service.latest(crypto.randomUUID())).rejects.toThrow("cannot access");
  await expect(f.service.tick(crypto.randomUUID())).rejects.toThrow("cannot access");
  expect(f.queries()).toBe(0);
  const result = await f.service.tick(f.userId, new Date("2026-09-16T22:00:00Z"));
  const directory = join(f.root, "storage", f.userId, "digests");
  const artifact = join(directory, "snapshots", `${result.digest!.sha256}.json`);
  await writeFile(artifact, '{"private":"do-not-log-this"}', { mode: 0o600 });
  await expect(f.service.latest(f.userId)).rejects.toThrow("could not be verified");
  await rm(join(directory, "snapshots"), { recursive: true });
  await symlink(f.root, join(directory, "snapshots"));
  await expect(f.service.latest(f.userId)).rejects.toThrow("could not be verified");
});

test("large inventories visibly mark bounded blocker and source coverage lists incomplete", async () => {
  const f = await harness();
  for (let i = 0; i < 501; i++) f.record("blocked");
  for (let i = 0; i < 1001; i++)
    f.sources.push({
      userId: f.userId,
      identity: `greenhouse:board${i}`,
      status: null,
      attemptedAt: null,
      completedAt: null,
      nextEligibleAt: null,
      coverage: {},
    });
  const result = await f.service.tick(f.userId, new Date("2026-09-16T22:00:00Z"));
  expect(result.digest!.counters.blocked).toBe(501);
  expect(result.digest!.blockers).toHaveLength(100);
  expect(result.digest!.blockersTruncated).toBe(true);
  expect(result.digest!.sourceCoverage.sources).toHaveLength(1000);
  expect(result.digest!.sourceCoverage.truncated).toBe(true);
});
