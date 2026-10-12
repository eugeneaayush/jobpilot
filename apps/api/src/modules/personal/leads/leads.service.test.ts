import "reflect-metadata";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { personalLeadSchema } from "@jobpilot/contracts/personal-leads";
import { personalSearchResponseSchema } from "@jobpilot/contracts/personal-search";
import { env } from "@/env";
import { objectValue } from "../runtime";
import { leadFixture, syntheticLeadCandidate } from "./fakes";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
let root: string;
let f: ReturnType<typeof leadFixture>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jobpilot-lead-tests-"));
  Object.assign(env, { PERSONAL_MODE: true, JOBPILOT_PERSONAL_ROOT: root });
  f = leadFixture();
  await writeFile(
    path.join(root, "runtime.json"),
    JSON.stringify({ account: { userId: f.userId } }),
  );
});
afterEach(async () => {
  Object.assign(env, original);
  await rm(root, { recursive: true, force: true });
});
async function importedId() {
  await f.service.import(f.userId, { candidates: [syntheticLeadCandidate] });
  return f.rows.find((row) => row.source === "lead:manual")!.id;
}

describe("private lead persistence and source boundary", () => {
  test("saves immutable source snapshots and deduplicates repeated destinations without creating records", async () => {
    const result = await f.service.import(f.userId, {
      candidates: [syntheticLeadCandidate, { ...syntheticLeadCandidate, sourceRowId: "second" }],
    });
    expect(result).toMatchObject({ imported: 1, duplicates: 1, status: "complete" });
    expect(f.discoverCount()).toBe(0);
    const first = f.rows.find((row) => row.source === "lead:manual")!;
    expect(objectValue(objectValue(first.details).lead)).toMatchObject({
      fullDescriptionAvailable: false,
      employerIdentityVerified: false,
    });
    const directory = path.join(root, "storage", f.userId, "lead-snapshots");
    const files = await readdir(directory);
    expect(files).toEqual([`${result.batchId}.snapshot`]);
    expect(await readFile(path.join(directory, files[0]!), "utf8")).toContain("source-row-42");
    expect(
      (await f.service.import(f.userId, { candidates: [syntheticLeadCandidate] })).duplicates,
    ).toBe(1);
    const response = await f.service.list(f.userId, {
      page: 1,
      limit: 10,
      source: "manual",
      status: "unresolved",
    });
    expect(response.pagination.total).toBe(1);
    expect(personalLeadSchema.safeParse(response.items[0]).success).toBe(true);
    expect(objectValue(f.calls.find((call) => call.operation === "findMany")?.args)).toMatchObject({
      skip: 0,
      take: 10,
      where: {
        userId: f.userId,
        source: "lead:manual",
        details: { path: ["lead", "resolution", "status"], equals: "unresolved" },
      },
    });
  });

  test("rejects other runtime users and keeps optional boards and feeds off before any invocation", async () => {
    await expect(
      f.service.import(crypto.randomUUID(), { candidates: [syntheticLeadCandidate] }),
    ).rejects.toThrow("cannot access");
    await expect(
      f.service.discover(f.userId, { board: "linkedin", query: "MBA", limit: 20 }),
    ).rejects.toThrow("disabled");
    await expect(
      f.service.importFeed(f.userId, {
        feed: "new_grad",
        format: "json",
        content: "[]",
        sourceUrl: "https://github.com/example/jobs",
        seasonYear: 2027,
        season: "any",
        maxAgeDays: 120,
      }),
    ).rejects.toThrow("disabled");
    expect(f.rows).toHaveLength(0);
  });

  test("resolves only a fresh authorized official requisition and preserves the lead's unverified provenance", async () => {
    const id = await importedId();
    const result = await f.service.resolve(f.userId, id, {
      campaignId: f.campaignId,
      runId: f.runId,
    });
    expect(f.discoverCount()).toBe(1);
    expect(result.resolution).toMatchObject({
      status: "resolved",
      sourceIdentity: "greenhouse:example",
    });
    expect(result.resolution.recordId).not.toBeNull();
    expect(result.employerIdentityVerified).toBe(false);
    await expect(
      f.service.resolve(f.userId, id, { campaignId: f.campaignId, runId: f.runId }),
    ).rejects.toThrow("already resolved");
    expect(f.discoverCount()).toBe(1);
  });

  test("does not fetch arbitrary destinations or promote an empty official description", async () => {
    const id = await importedId();
    await expect(
      f.service.resolve(f.userId, id, {
        campaignId: f.campaignId,
        runId: f.runId,
        officialUrl: "https://attacker.example/redirect",
      }),
    ).rejects.toThrow("supported official");
    expect(f.discoverCount()).toBe(0);
    f.setEmptyDescription();
    await expect(
      f.service.resolve(f.userId, id, { campaignId: f.campaignId, runId: f.runId }),
    ).rejects.toThrow("full-description");
    expect(
      objectValue(
        objectValue(objectValue(f.rows.find((row) => row.id === id)!.details).lead).resolution,
      ).status,
    ).toBe("blocked");
  });

  test("requires current campaign run, source registration and owner-attested employer before discovery", async () => {
    const id = await importedId();
    await expect(
      f.service.resolve(f.userId, id, { campaignId: f.campaignId, runId: crypto.randomUUID() }),
    ).rejects.toThrow("authorization changed");
    f.registry.configuration = null;
    await expect(
      f.service.resolve(f.userId, id, { campaignId: f.campaignId, runId: f.runId }),
    ).rejects.toThrow("registered");
    f.registry.configuration = { source: "greenhouse", boardToken: "example" };
    f.alias.evidence = {};
    await expect(
      f.service.resolve(f.userId, id, { campaignId: f.campaignId, runId: f.runId }),
    ).rejects.toThrow("employer identity");
    expect(f.discoverCount()).toBe(0);
  });

  test("Brave empty, partial and blocked receipts use the same durable lead boundary", async () => {
    for (const status of ["complete", "partial", "blocked", "failed"] as const) {
      const response = personalSearchResponseSchema.parse({
        provider: "brave",
        status,
        queryHash: "a".repeat(64),
        candidates:
          status === "partial"
            ? [
                {
                  kind: "career_url_candidate",
                  url: syntheticLeadCandidate.originalUrl,
                  urlHash: "b".repeat(64),
                  title: "Career lead",
                  snippet: "Snippet only",
                  evidence: "search_snippet",
                  fullDescriptionAvailable: false,
                  employerIdentityVerified: false,
                  page: 0,
                  responseHash: "c".repeat(64),
                },
              ]
            : [],
        coverage: {
          scope: "search_query",
          exhausted: status === "complete",
          empty: status === "complete" ? true : null,
          pagesRequested: 1,
          observedCount: 0,
          invalidCount: 0,
          duplicateCount: 0,
          moreResultsAvailable: false,
        },
        receipts: [],
        budget: null,
        nextEligibleAt: null,
        reasons: [],
        price: {
          requestMicrousd: 5000,
          verifiedOn: "2026-09-16",
          sourceUrl: "https://brave.com/search/api/",
          creditsAssumed: false,
        },
      });
      const batch = await f.service.importBrave(f.userId, response);
      expect(batch.status).toBe(status);
      expect(batch.imported).toBe(status === "partial" ? 1 : 0);
    }
    expect(f.discoverCount()).toBe(0);
  });

  test("enabled feeds preserve malformed input as failed evidence and never call official discovery", async () => {
    await writeFile(
      path.join(root, "runtime.json"),
      JSON.stringify({ account: { userId: f.userId }, leadDiscovery: { feeds: ["new_grad"] } }),
    );
    const result = await f.service.importFeed(f.userId, {
      feed: "new_grad",
      format: "json",
      content: "not JSON",
      sourceUrl: "https://github.com/example/jobs",
      seasonYear: 2027,
      season: "any",
      maxAgeDays: 120,
    });
    expect(result.status).toBe("failed");
    expect(result.imported).toBe(0);
    expect(f.discoverCount()).toBe(0);
    expect(f.rows[0]?.source).toBe("lead_batch:new_grad");
  });

  test("an in-progress resolution claim fences a second resolver", async () => {
    const id = await importedId();
    const row = f.rows.find((item) => item.id === id)!;
    const details = objectValue(row.details);
    const lead = objectValue(details.lead);
    row.details = {
      ...details,
      claim: crypto.randomUUID(),
      claimExpiresAt: new Date(Date.now() + 60000).toISOString(),
      lead: { ...lead, resolution: { ...objectValue(lead.resolution), status: "resolving" } },
    };
    await expect(
      f.service.resolve(f.userId, id, { campaignId: f.campaignId, runId: f.runId }),
    ).rejects.toThrow("already being resolved");
    expect(f.discoverCount()).toBe(0);
  });
});
