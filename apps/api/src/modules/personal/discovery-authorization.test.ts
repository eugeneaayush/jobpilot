import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@/env";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PersonalDiscoveryService } from "./discovery.service";
import { verifyDiscoveryAuthorization } from "./discovery-authorization";
import type { PersonalService } from "./personal.service";
import { PersonalSearchService } from "./search/search.service";
import { afterEach, beforeEach, expect, test } from "bun:test";

const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jobpilot-discovery-authorization-"));
  env.PERSONAL_MODE = true;
  env.JOBPILOT_PERSONAL_ROOT = root;
});
afterEach(async () => {
  Object.assign(env, original);
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const userId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const policy = {
    name: "Synthetic discovery",
    scheduler: "personal-campaign-v1",
    enabled: true,
    policyVersion: "test",
    mode: "offline",
    tracks: ["mba_internship"],
    sources: {
      boardTokens: ["alpha"],
      instances: [
        { source: "lever", boardToken: "beta", region: "eu" },
        { source: "ashby", boardToken: "gamma" },
      ],
    },
    fitThreshold: 0,
    dailyCap: 1,
    maxApplications: 1,
    timezone: "America/New_York",
    authorization: {
      runId,
      authorizedAt: new Date().toISOString(),
      settingsHash: "synthetic",
      resumeEvidenceId: crypto.randomUUID(),
      sourceHash: "synthetic",
      snapshotHash: "synthetic",
      settings: {},
    },
  };
  const campaign = { campaignId, userId, status: "in_progress", config: { personal: policy } };
  const calls: unknown[] = [];
  const prisma = {
    campaign: {
      findFirst: async ({ where }: { where: { campaignId: string; userId: string } }) => {
        calls.push(where);
        return where.campaignId === campaignId && where.userId === userId ? campaign : null;
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, "campaign">;
  const input = { campaignId, runId };
  const configure = async (queries: unknown, owner = userId) =>
    writeFile(
      join(root, "runtime.json"),
      JSON.stringify({ account: { userId: owner }, pilotDiscovery: { queries } }),
      { mode: 0o600 },
    );
  return { userId, campaignId, runId, policy, campaign, calls, prisma, input, configure };
}

test("explicit manual discovery without campaign context remains allowed without configuration access", async () => {
  const f = fixture();
  await verifyDiscoveryAuthorization(f.prisma, f.userId, {}, "greenhouse:manual");
  await verifyDiscoveryAuthorization(f.prisma, f.userId, { query: "manual public career search" });
  expect(f.calls).toHaveLength(0);
});

test("a campaign/run pair is required before any scheduled source lookup", async () => {
  const f = fixture();
  for (const input of [{ campaignId: f.campaignId }, { runId: f.runId }])
    await expect(verifyDiscoveryAuthorization(f.prisma, f.userId, input)).rejects.toThrow(
      "both be supplied",
    );
  expect(f.calls).toHaveLength(0);
});

test("stopped, disabled, and superseded runs cannot authorize scheduled discovery", async () => {
  const f = fixture();
  f.campaign.status = "paused";
  await expect(verifyDiscoveryAuthorization(f.prisma, f.userId, f.input)).rejects.toThrow(
    "stopped or authorization changed",
  );
  f.campaign.status = "in_progress";
  f.policy.enabled = false;
  await expect(verifyDiscoveryAuthorization(f.prisma, f.userId, f.input)).rejects.toThrow(
    "stopped or authorization changed",
  );
  f.policy.enabled = true;
  await expect(
    verifyDiscoveryAuthorization(f.prisma, f.userId, { ...f.input, runId: crypto.randomUUID() }),
  ).rejects.toThrow("stopped or authorization changed");
});

test("campaign lookup is scoped to the authenticated owner and exact campaign", async () => {
  const f = fixture();
  const foreign = crypto.randomUUID();
  await expect(verifyDiscoveryAuthorization(f.prisma, foreign, f.input)).rejects.toThrow(
    "unavailable",
  );
  expect(f.calls[0]).toEqual({ campaignId: f.campaignId, userId: foreign });
  await expect(
    verifyDiscoveryAuthorization(f.prisma, f.userId, {
      ...f.input,
      campaignId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("unavailable");
});

test("source scope matches exact board and Lever region, without fuzzy or cross-ATS aliases", async () => {
  const f = fixture();
  for (const source of ["greenhouse:alpha", "lever:eu:beta", "ashby:gamma"])
    await verifyDiscoveryAuthorization(f.prisma, f.userId, f.input, source);
  for (const source of ["greenhouse:alpha-other", "lever:global:beta", "ashby:beta", "cbs:alpha"])
    await expect(verifyDiscoveryAuthorization(f.prisma, f.userId, f.input, source)).rejects.toThrow(
      "outside the campaign scope",
    );
});

test("scheduled search must match the owner's configured query and campaign exactly", async () => {
  const f = fixture();
  const query = "synthetic employer graduate careers";
  await f.configure([{ campaignId: f.campaignId, query }]);
  await verifyDiscoveryAuthorization(f.prisma, f.userId, { ...f.input, query });
  await expect(
    verifyDiscoveryAuthorization(f.prisma, f.userId, { ...f.input, query: `${query} extra` }),
  ).rejects.toThrow("not configured");
  await f.configure([{ campaignId: crypto.randomUUID(), query }]);
  await expect(
    verifyDiscoveryAuthorization(f.prisma, f.userId, { ...f.input, query }),
  ).rejects.toThrow("not configured");
});

test("scheduled search cannot exceed configured pagination or implicit defaults", async () => {
  const f = fixture();
  const query = "synthetic bounded career search";
  const input = { ...f.input, query };
  await f.configure([{ campaignId: f.campaignId, query, maxPages: 2, pageSize: 5 }]);
  for (const limits of [
    { maxPages: 2, pageSize: 5 },
    { maxPages: 1, pageSize: 3 },
  ])
    await verifyDiscoveryAuthorization(f.prisma, f.userId, { ...input, ...limits });
  for (const limits of [{ maxPages: 3, pageSize: 5 }, { maxPages: 2, pageSize: 6 }, {}])
    await expect(
      verifyDiscoveryAuthorization(f.prisma, f.userId, { ...input, ...limits }),
    ).rejects.toThrow("not configured");
  await f.configure([{ campaignId: f.campaignId, query }]);
  await verifyDiscoveryAuthorization(f.prisma, f.userId, input);
  await verifyDiscoveryAuthorization(f.prisma, f.userId, { ...input, maxPages: 3, pageSize: 20 });
  for (const limits of [{ maxPages: 4 }, { pageSize: 21 }])
    await expect(
      verifyDiscoveryAuthorization(f.prisma, f.userId, { ...input, ...limits }),
    ).rejects.toThrow("not configured");
});

test("missing or malformed query configuration and a foreign runtime owner cannot authorize search", async () => {
  const f = fixture();
  const input = { ...f.input, query: "synthetic public careers" };
  for (const queries of [null, {}, [], [null], [{ query: input.query }]]) {
    await f.configure(queries);
    await expect(verifyDiscoveryAuthorization(f.prisma, f.userId, input)).rejects.toThrow(
      "not configured",
    );
  }
  await f.configure([{ campaignId: f.campaignId, query: input.query }], crypto.randomUUID());
  await expect(verifyDiscoveryAuthorization(f.prisma, f.userId, input)).rejects.toThrow(
    "cannot access the private runtime",
  );
});

test("discovery rejects stopped authorization before source reservation or applicant access", async () => {
  const f = fixture();
  f.campaign.status = "paused";
  let accessed = 0;
  const forbidden = async () => {
    accessed++;
    throw new Error("Synthetic downstream access is forbidden");
  };
  const tx = {
    ...f.prisma,
    $queryRaw: async () => [{ id: f.userId }],
    personalSource: { findUnique: forbidden, upsert: forbidden },
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const personal = { resumeData: forbidden } as unknown as PersonalService;
  const service = new PersonalDiscoveryService(prisma, personal);
  await expect(service.discover(f.userId, { ...f.input, boardToken: "alpha" })).rejects.toThrow(
    "stopped or authorization changed",
  );
  expect(accessed).toBe(0);
});

test("search rejects a superseded run before provider setup, spend, or receipt writes", async () => {
  const f = fixture();
  let receipts = 0;
  const prisma = {
    ...f.prisma,
    personalDiscoveryRun: {
      create: async () => {
        receipts++;
      },
    },
  } as unknown as PrismaClient;
  const service = new PersonalSearchService(prisma);
  await expect(
    service.search(f.userId, {
      ...f.input,
      runId: crypto.randomUUID(),
      query: "synthetic public careers",
    }),
  ).rejects.toThrow("stopped or authorization changed");
  expect(receipts).toBe(0);
});
