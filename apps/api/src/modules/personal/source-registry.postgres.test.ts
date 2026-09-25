import "reflect-metadata";
import type { PersonalTestDatabase } from "./persistence-test-fixtures";
import { PersonalSourceRegistryService } from "./source-registry.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("source registry PostgreSQL ownership and concurrency", () => {
  let db: PersonalTestDatabase;
  let registry: PersonalSourceRegistryService;
  beforeAll(async () => {
    const { createPersonalTestDatabase } = await import("./persistence-test-fixtures");
    db = await createPersonalTestDatabase(testUrl!);
    registry = new PersonalSourceRegistryService(db.prisma);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function fixture() {
    const user = await db.prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test`, username: crypto.randomUUID() },
    });
    const configuration = {
      source: "greenhouse" as const,
      boardToken: `board-${crypto.randomUUID()}`,
    };
    const source = await registry.upsert(user.id, { configuration, expectedUpdatedAt: null });
    const quote = "Example Corporation recruits MBA interns for its investment team.";
    const postingHash = "a".repeat(64);
    const record = await db.prisma.personalRecord.create({
      data: {
        userId: user.id,
        identity: `${source.identity}:123`,
        title: "MBA Intern",
        company: "Example Corporation",
        url: "https://job-boards.greenhouse.io/example/jobs/123",
        track: "mba_internship",
        details: {
          posting: {
            source: "greenhouse",
            boardToken: configuration.boardToken,
            contentHash: postingHash,
            descriptionText: quote,
            sourceUrl: `https://boards-api.greenhouse.io/v1/boards/${configuration.boardToken}/jobs`,
          },
        },
      },
    });
    const alias = {
      source: configuration,
      officialDomain: "example.com",
      recordId: record.id,
      postingContentHash: postingHash,
      quote,
      ownerConfirmsOfficialIdentity: true as const,
      expectedEvidenceHash: null,
    };
    return { user, configuration, source, record, alias };
  }
  test("registry is owner scoped and source edits preserve saved health and cooldown", async () => {
    const f = await fixture();
    const other = await fixture();
    const cooldown = new Date(Date.now() + 60000);
    const row = await db.prisma.personalSource.update({
      where: { id: f.source.id },
      data: {
        status: "partial",
        attemptedAt: new Date(),
        nextEligibleAt: cooldown,
        coverage: { count: 2, exhausted: false },
      },
    });
    const updated = await registry.upsert(f.user.id, {
      configuration: { ...f.configuration, employer: "Display label" },
      expectedUpdatedAt: row.updatedAt.toISOString(),
    });
    expect(updated.nextEligibleAt).toEqual(cooldown);
    expect(updated.status).toBe("partial");
    expect(updated.coverage).toEqual({ count: 2, exhausted: false });
    expect((await registry.list(other.user.id)).sources.map((source) => source.id)).toEqual([
      other.source.id,
    ]);
    await expect(
      registry.upsert(f.user.id, {
        configuration: f.configuration,
        expectedUpdatedAt: row.updatedAt.toISOString(),
      }),
    ).rejects.toThrow("reload");
  });
  test("same-version concurrent config updates allow one winner", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      ["A", "B"].map((employer) =>
        registry.upsert(f.user.id, {
          configuration: { ...f.configuration, employer },
          expectedUpdatedAt: f.source.updatedAt.toISOString(),
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  test("alias requires matching owned source evidence and preserves exact review history", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      registry.registerAlias(f.user.id, { ...f.alias, recordId: other.record.id }),
    ).rejects.toThrow("Owned evidence");
    await expect(
      registry.registerAlias(f.user.id, {
        ...f.alias,
        quote: "This unsupported quote does not occur in the posting.",
      }),
    ).rejects.toThrow("verbatim");
    await expect(
      registry.registerAlias(f.user.id, { ...f.alias, postingContentHash: "b".repeat(64) }),
    ).rejects.toThrow("changed");
    const first = await registry.registerAlias(f.user.id, f.alias);
    expect(first.canonicalEmployer).toBe("domain:example.com");
    expect(first.verification).toBe("owner_attested");
    const replacement = await registry.registerAlias(f.user.id, {
      ...f.alias,
      officialDomain: "careers.example.com",
      expectedEvidenceHash: first.evidenceHash,
    });
    expect(replacement.canonicalEmployer).toBe("domain:careers.example.com");
    expect(replacement.evidence).toMatchObject({
      history: [{ canonicalEmployer: "domain:example.com" }],
    });
    await expect(
      registry.registerAlias(f.user.id, { ...f.alias, expectedEvidenceHash: first.evidenceHash }),
    ).rejects.toThrow("changed");
    expect((await registry.listAliases(other.user.id)).aliases).toHaveLength(0);
    const saved = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } });
    expect(saved.details).not.toHaveProperty("verifiedEmployerCareerSource");
  });
  test("prior attempts make alias creation and replacement immutable", async () => {
    for (const alreadyAliased of [false, true]) {
      const f = await fixture();
      const old = alreadyAliased ? await registry.registerAlias(f.user.id, f.alias) : null;
      await db.prisma.personalAttempt.create({
        data: {
          userId: f.user.id,
          recordId: f.record.id,
          campaignId: "synthetic-history",
          mode: "offline",
          state: "prepared",
          manifest: {},
          manifestHash: "a".repeat(64),
          leaseOwner: "synthetic",
          leaseExpiresAt: new Date(),
          attemptNo: 1,
          policyDay: "2026-09-16",
        },
      });
      await expect(
        registry.registerAlias(f.user.id, {
          ...f.alias,
          expectedEvidenceHash: old?.evidenceHash ?? null,
        }),
      ).rejects.toThrow("immutable");
      expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(1);
    }
  });
  test("policy changes are downward-only, optimistic and cannot cancel historical work", async () => {
    const f = await fixture();
    const initial = await registry.policy(f.user.id);
    expect(initial.updatedAt).toBeNull();
    const lower = await registry.configurePolicy(f.user.id, {
      expectedUpdatedAt: null,
      dailyCap: 5,
      employerActiveCap: 1,
      monthlyBudgetCents: 10000,
      searchBudgetCents: 1000,
    });
    expect(lower).toMatchObject({
      dailyCap: 5,
      employerActiveCap: 1,
      monthlyBudgetCents: 10000,
      searchBudgetCents: 1000,
      timezone: "America/New_York",
    });
    await expect(
      registry.configurePolicy(f.user.id, {
        expectedUpdatedAt: lower.updatedAt?.toISOString() ?? null,
        dailyCap: 6,
      }),
    ).rejects.toThrow("lowered");
    await expect(
      registry.configurePolicy(f.user.id, { expectedUpdatedAt: null, dailyCap: 1 }),
    ).rejects.toThrow("reload");
    await expect(
      registry.configurePolicy(f.user.id, {
        expectedUpdatedAt: lower.updatedAt?.toISOString() ?? null,
        monthlyBudgetCents: 100,
      }),
    ).rejects.toThrow("Search budget");
    const stop = await registry.configurePolicy(f.user.id, {
      expectedUpdatedAt: lower.updatedAt?.toISOString() ?? null,
      dailyCap: 0,
    });
    expect(stop.dailyCap).toBe(0);
    expect(
      (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: f.record.id } })).state,
    ).toBe("discovered");
  });
});
