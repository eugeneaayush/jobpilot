import "reflect-metadata";
import {
  personalEmployerAliasUpsertSchema,
  personalRegistryResponseSchema,
  personalSourceUpsertSchema,
  personalUserPolicySchema,
  personalUserPolicyUpdateSchema,
} from "@jobpilot/contracts/personal-registry";
import type { PersonalSource, PrismaClient } from "@/generated/prisma/client";
import { PersonalSourceRegistryService } from "./source-registry.service";
import { describe, expect, test } from "bun:test";

const checked = new Date("2026-09-16T12:00:00Z");
const source = (kind = "greenhouse"): PersonalSource => ({
  id: crypto.randomUUID(),
  userId: "synthetic-user",
  identity: kind === "lever" ? "lever:global:example" : `${kind}:example`,
  configuration: { source: kind, boardToken: "example" },
  attemptedAt: checked,
  completedAt: checked,
  nextEligibleAt: new Date("2026-09-17T12:00:00Z"),
  status: "partial",
  coverage: { count: 3, exhausted: false },
  updatedAt: checked,
});
const service = (db: unknown) => new PersonalSourceRegistryService(db as PrismaClient);

describe("personal registry contracts and metadata", () => {
  test("list reports capability separately from readiness and preserves failure history", async () => {
    let where: unknown;
    const rows = [source(), source("ashby"), source("cbs"), source("lever")];
    const result = await service({
      personalSource: {
        findMany: async (query: unknown) => {
          where = query;
          return rows;
        },
        count: async () => rows.length,
      },
    }).list("owner");
    expect(where).toMatchObject({ where: { userId: "owner" }, take: 25, skip: 0 });
    expect(result.sources[0]).toMatchObject({
      attemptedAt: checked,
      lastSuccessfulAt: checked,
      status: "partial",
      coverage: { count: 3, exhausted: false },
      adapter: {
        discovery: "public_api",
        submission: "guarded_greenhouse",
        readiness: "not_evaluated",
        submissionEnabledByRegistration: false,
      },
    });
    expect(result.sources[1]?.adapter.submission).toBe("unsupported");
    expect(result.sources[2]?.adapter.discovery).toBe("import_only");
    expect(result.sources[3]?.adapter.submission).toBe("restricted_lever");
    expect(personalRegistryResponseSchema.safeParse(result).success).toBe(true);
  });
  test("malformed registered configuration is explicit and never echoed as trusted setup", async () => {
    const row = {
      ...source(),
      configuration: { source: "unexpected", apiKey: "do-not-echo-canary" },
    };
    const result = await service({
      personalSource: { findMany: async () => [row], count: async () => 1 },
    }).list("owner");
    expect(result.sources[0]?.configurationState).toBe("invalid");
    expect(result.sources[0]?.adapter.discovery).toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("do-not-echo-canary");
  });
  test("registry pagination exposes the whole source count beyond the first hundred", async () => {
    let selection: unknown;
    const result = await service({
      personalSource: {
        findMany: async (query: unknown) => {
          selection = query;
          return [source()];
        },
        count: async () => 347,
      },
    }).list("owner", { page: 4, limit: 100 });
    expect(selection).toMatchObject({ skip: 300, take: 100 });
    expect(result.pagination).toEqual({ page: 4, limit: 100, total: 347, totalPages: 4 });
  });
  test("exact region scope and optimistic update versions are required", () => {
    expect(
      personalSourceUpsertSchema.safeParse({
        configuration: { source: "lever", boardToken: "example", region: "eu" },
        expectedUpdatedAt: null,
      }).success,
    ).toBe(true);
    for (const configuration of [
      { source: "ashby", boardToken: "example", region: "eu" },
      { source: "lever", boardToken: "../example" },
      { source: "greenhouse", boardToken: "example", apiKey: "injected" },
    ]) {
      expect(
        personalSourceUpsertSchema.safeParse({ configuration, expectedUpdatedAt: null }).success,
      ).toBe(false);
    }
    expect(
      personalSourceUpsertSchema.safeParse({
        configuration: { source: "cbs", boardToken: "example" },
      }).success,
    ).toBe(false);
  });
  test("source config edits do not reset cooldown, attempt, success, or coverage", async () => {
    const row = source();
    let update: Record<string, unknown> = {};
    const tx = {
      $queryRaw: async () => [{ id: "owner" }],
      personalSource: {
        findUnique: async () => row,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          update = data;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({ ...row, ...update }),
      },
    };
    const registry = service({ $transaction: async (fn: (value: unknown) => unknown) => fn(tx) });
    const result = await registry.upsert("owner", {
      configuration: {
        source: "greenhouse",
        boardToken: "example",
        employer: "Reviewed display name",
      },
      expectedUpdatedAt: checked.toISOString(),
    });
    expect(Object.keys(update).sort()).toEqual(["configuration", "updatedAt"]);
    expect(result.nextEligibleAt).toEqual(row.nextEligibleAt);
    expect(result.coverage).toEqual({ count: 3, exhausted: false });
    await expect(
      registry.upsert("owner", {
        configuration: { source: "greenhouse", boardToken: "example" },
        expectedUpdatedAt: null,
      }),
    ).rejects.toThrow("reload");
  });
  test("default policy is bounded and GET does not create mutable state", async () => {
    const policy = await service({ personalPolicy: { findUnique: async () => null } }).policy(
      "owner",
    );
    expect(policy).toMatchObject({
      dailyCap: 50,
      employerActiveCap: 3,
      monthlyBudgetCents: 20000,
      searchBudgetCents: 5000,
      timezone: "America/New_York",
      updatedAt: null,
      adjustment: "downward_only",
    });
    expect(personalUserPolicySchema.safeParse(policy).success).toBe(true);
    for (const update of [
      { dailyCap: 51 },
      { employerActiveCap: 4 },
      { monthlyBudgetCents: 20001 },
      { searchBudgetCents: 5001 },
      { timezone: "UTC" },
    ]) {
      expect(
        personalUserPolicyUpdateSchema.safeParse({ ...update, expectedUpdatedAt: null }).success,
      ).toBe(false);
    }
    expect(
      personalUserPolicyUpdateSchema.safeParse({ dailyCap: 0, expectedUpdatedAt: null }).success,
    ).toBe(true);
  });
  test("alias input uses explicit attestation and exact public domain identity", () => {
    const input = {
      source: { source: "greenhouse", boardToken: "example" },
      officialDomain: "EXAMPLE.COM",
      recordId: crypto.randomUUID(),
      postingContentHash: "a".repeat(64),
      quote: "Example Company is the hiring employer.",
      ownerConfirmsOfficialIdentity: true,
      expectedEvidenceHash: null,
    };
    expect(personalEmployerAliasUpsertSchema.parse(input).officialDomain).toBe("example.com");
    for (const officialDomain of [
      "Example Company",
      "https://example.com/jobs",
      "127.0.0.1",
      "private.local",
      "example.com:443",
    ]) {
      expect(
        personalEmployerAliasUpsertSchema.safeParse({ ...input, officialDomain }).success,
      ).toBe(false);
    }
    expect(
      personalEmployerAliasUpsertSchema.safeParse({
        ...input,
        ownerConfirmsOfficialIdentity: false,
      }).success,
    ).toBe(false);
    expect(
      personalEmployerAliasUpsertSchema.safeParse({
        ...input,
        source: { source: "cbs", boardToken: "all-employers" },
      }).success,
    ).toBe(false);
  });
});
