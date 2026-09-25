import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { manifestHash } from "./persistence-policy";
import type { PersonalTestDatabase, personalFixture } from "./persistence-test-fixtures";
import { objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("source-backed employer caps at the reservation boundary", () => {
  let db: PersonalTestDatabase;
  let fixture: typeof personalFixture;
  beforeAll(async () => {
    const helpers = await import("./persistence-test-fixtures");
    db = await helpers.createPersonalTestDatabase(testUrl!);
    fixture = helpers.personalFixture;
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  async function cap(userId: string, maxActiveApplications: number) {
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({
        account: { userId },
        employerPolicies: [
          {
            canonicalEmployer: "domain:synthetic.example.com",
            maxActiveApplications,
            evidence: {
              verification: "owner_attested",
              sourceUrl: "https://synthetic.example.com/careers/policy",
              sha256: "a".repeat(64),
              quote: "Synthetic fixture policy: at most one active application per candidate.",
              ownerConfirmsPolicy: true,
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
  }
  async function setup() {
    const f = await fixture(db, "submit", 50);
    const first = await f.record();
    const second = await f.record();
    const posting = objectValue(objectValue(first.record.details).posting);
    await db.prisma.personalEmployerAlias.create({
      data: {
        userId: f.user.id,
        sourceEmployer: "greenhouse:synthetic",
        canonicalEmployer: "domain:synthetic.example.com",
        evidence: {
          schemaVersion: 1,
          verification: "owner_attested",
          ownerId: f.user.id,
          attestedAt: new Date().toISOString(),
          officialDomain: "synthetic.example.com",
          recordId: first.record.id,
          postingContentHash: manifestHash(posting),
          sourceUrl: "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs",
          quote: String(posting.descriptionText),
          history: [],
        },
      },
    });
    const campaign = await db.prisma.campaign.create({
      data: {
        userId: f.user.id,
        query: "Second synthetic campaign",
        source: "apply",
        config: f.campaign.config as never,
      },
    });
    second.input.campaignId = campaign.campaignId;
    await cap(f.user.id, 1);
    return { ...f, first, second };
  }

  it("reserves only one across simultaneous campaigns when the employer ceiling is one", async () => {
    const f = await setup();
    const results = await Promise.allSettled([
      db.service.start(f.user.id, f.first.input),
      db.service.start(f.user.id, f.second.input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(1);
    expect(
      await db.prisma.personalAttempt.count({
        where: { userId: f.user.id, submitAt: { not: null } },
      }),
    ).toBe(0);
  });
  it("tightening the employer ceiling holds an already prepared final action", async () => {
    const f = await setup();
    const attempt = await db.service.start(f.user.id, f.first.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await cap(f.user.id, 0);
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "active-application limit",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
  });
  it("legacy alias evidence cannot establish identity or reserve an application", async () => {
    const f = await setup();
    await db.prisma.personalEmployerAlias.updateMany({
      where: { userId: f.user.id },
      data: { evidence: { verification: "legacy_unverified" } },
    });
    await expect(db.service.start(f.user.id, f.first.input)).rejects.toThrow(
      "Employer alias evidence is unverified",
    );
    expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(0);
  });
  it("a configured employer ceiling of three cannot override a lower user ceiling", async () => {
    const f = await setup();
    await cap(f.user.id, 3);
    await db.prisma.personalPolicy.create({ data: { userId: f.user.id, employerActiveCap: 1 } });
    await db.service.start(f.user.id, f.first.input);
    await expect(db.service.start(f.user.id, f.second.input)).rejects.toThrow(
      "active-application limit",
    );
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(1);
  });
});
