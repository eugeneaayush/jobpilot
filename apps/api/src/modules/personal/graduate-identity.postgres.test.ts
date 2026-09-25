import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { eligibilityContext } from "./eligibility-freshness";
import { manifestHash } from "./persistence-policy";
import type { PersonalTestDatabase, personalFixture } from "./persistence-test-fixtures";
import { jsonValue, objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
type Fixture = Awaited<ReturnType<typeof personalFixture>>;
describe.skipIf(!testUrl)("graduate identity and policy submission regressions", () => {
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

  async function role(
    f: Fixture,
    source: "greenhouse" | "ashby" | "cbs",
    company: string,
    boardToken = "synthetic",
  ) {
    const r = await f.record();
    const details = objectValue(r.record.details);
    const nativeId = r.record.requisitionId!;
    const sourceIdentity = personalSourceIdentity({ source, boardToken });
    const identity = `${sourceIdentity}:${nativeId}`;
    const posting = {
      ...objectValue(details.posting),
      source,
      boardToken,
      employer: company,
      requisitionId: "MBA-2027-ONE",
    };
    const attachmentRequirements = {
      ...r.input.manifest.attachmentRequirements,
      identity,
      postingContentHash: manifestHash(posting),
    };
    r.record = await db.prisma.personalRecord.update({
      where: { id: r.record.id },
      data: {
        identity,
        company,
        details: { ...details, posting, attachmentRequirements } as never,
      },
    });
    r.record = await db.prisma.personalRecord.update({
      where: { id: r.record.id },
      data: {
        details: jsonValue({
          ...objectValue(r.record.details),
          eligibilityContext: eligibilityContext(r.record, {
            settings: f.settings,
            evidence: f.resume,
          }),
        }),
      },
    });
    r.input.manifest.attachmentRequirements = attachmentRequirements;
    return { ...r, sourceIdentity };
  }
  async function alias(
    f: Fixture,
    sourceEmployer: string,
    canonicalEmployer = "domain:synthetic.example.com",
  ) {
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({ account: { userId: f.user.id }, employerPolicies: [] }),
    );
    const record = await db.prisma.personalRecord.findFirstOrThrow({
      where: { userId: f.user.id, identity: { startsWith: `${sourceEmployer}:` } },
    });
    const posting = objectValue(objectValue(record.details).posting);
    await db.prisma.personalEmployerAlias.create({
      data: {
        userId: f.user.id,
        sourceEmployer,
        canonicalEmployer,
        evidence: {
          schemaVersion: 1,
          verification: "owner_attested",
          ownerId: f.user.id,
          attestedAt: new Date().toISOString(),
          officialDomain: canonicalEmployer.slice(7),
          recordId: record.id,
          postingContentHash: manifestHash(posting),
          sourceUrl: "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs",
          quote: String(posting.descriptionText),
          history: [],
        },
      },
    });
  }

  it("missing availability cannot reserve even with a ready eligible manifest", async () => {
    const f = await fixture(db);
    const r = await f.record();
    await writeFile(join(db.root, "settings", `${f.user.id}.json`), "{}", { mode: 0o600 });
    await expect(db.service.start(f.user.id, r.input)).rejects.toThrow(
      "Approved recruiting availability",
    );
    expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(0);
  });
  it("one aliased employer requisition cannot reserve through two ATS labels", async () => {
    const f = await fixture(db, "submit", 50);
    const a = await role(f, "greenhouse", "Synthetic Capital");
    const b = await role(f, "ashby", "Synthetic Capital LLC");
    await alias(f, a.sourceIdentity);
    await alias(f, b.sourceIdentity);
    const result = await Promise.allSettled([
      db.service.start(f.user.id, a.input),
      db.service.start(f.user.id, b.input),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(1);
  });
  it("retains the immutable aliased key even if the old posting later becomes invalid", async () => {
    const f = await fixture(db);
    const a = await role(f, "greenhouse", "Synthetic Capital");
    const b = await role(f, "ashby", "Synthetic Capital LLC");
    await alias(f, a.sourceIdentity);
    await alias(f, b.sourceIdentity);
    const prior = await db.service.start(f.user.id, a.input);
    await db.prisma.personalRecord.update({
      where: { id: a.record.id },
      data: { details: { posting: {} } },
    });
    await expect(db.service.start(f.user.id, b.input)).rejects.toThrow("owns this job lease");
    const after = await db.service.get(f.user.id, prior.id);
    expect(after.manifestHash).toBe(prior.manifestHash);
    expect(after.manifest).toEqual(prior.manifest);
  });
  it("distinct canonical employers with the same display name and req stay separate", async () => {
    const f = await fixture(db);
    const a = await role(f, "greenhouse", "Synthetic Capital");
    const b = await role(f, "ashby", "Synthetic Capital");
    await alias(f, a.sourceIdentity, "domain:one.example.com");
    await alias(f, b.sourceIdentity, "domain:two.example.com");
    await db.service.start(f.user.id, a.input);
    await db.service.start(f.user.id, b.input);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(2);
  });
  it("CBS board aliases cannot merge unrelated employers or share their employer cap", async () => {
    const f = await fixture(db);
    const a = await role(f, "cbs", "Fund One", "class2028");
    const b = await role(f, "cbs", "Fund Two", "class2028");
    await alias(f, a.sourceIdentity, "domain:wrong.example.com");
    await db.prisma.personalPolicy.create({ data: { userId: f.user.id, employerActiveCap: 1 } });
    await db.service.start(f.user.id, a.input);
    await db.service.start(f.user.id, b.input);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(2);
  });
  it("50 reservations across campaigns exhaust the global daily cap", async () => {
    const f = await fixture(db, "submit", 100);
    const a = await f.record();
    const first = await db.service.start(f.user.id, a.input);
    await db.prisma.personalAttempt.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        userId: f.user.id,
        recordId: a.record.id,
        campaignId: f.campaign.campaignId,
        mode: "submit" as const,
        state: "submitted" as const,
        manifest: first.manifest as never,
        manifestHash: first.manifestHash,
        leaseOwner: crypto.randomUUID(),
        leaseExpiresAt: new Date(),
        attemptNo: index + 2,
        policyDay: first.policyDay,
        submitAt: new Date(),
      })),
    });
    const other = await db.prisma.campaign.create({
      data: {
        userId: f.user.id,
        query: "Another synthetic campaign",
        source: "apply",
        config: f.campaign.config as never,
      },
    });
    const b = await role(f, "ashby", "Another Employer");
    b.input.campaignId = other.campaignId;
    await expect(db.service.start(f.user.id, b.input)).rejects.toThrow("cap reached");
    expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(50);
  });
  it("rejects a campaign timezone shift and a lower cap after preparation", async () => {
    const f = await fixture(db);
    const a = await f.record();
    const attempt = await db.service.start(f.user.id, a.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.prisma.personalPolicy.update({ where: { userId: f.user.id }, data: { dailyCap: 1 } });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "User policy changed",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
    const b = await role(f, "ashby", "Another Employer");
    const config = objectValue(f.campaign.config);
    await db.prisma.campaign.update({
      where: { campaignId: f.campaign.campaignId },
      data: {
        config: {
          ...config,
          personal: { ...objectValue(config.personal), timezone: "UTC" },
        } as never,
      },
    });
    await expect(db.service.start(f.user.id, b.input)).rejects.toThrow("authoritative user policy");
  });
  it("holds continuation if the user policy changes after submit intent", async () => {
    const f = await fixture(db);
    const a = await f.record();
    const attempt = await db.service.start(f.user.id, a.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.service.beginSubmit(f.user.id, attempt.id, attempt);
    await db.prisma.personalPolicy.update({
      where: { userId: f.user.id },
      data: { employerActiveCap: 0 },
    });
    const current = await db.prisma.personalAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    await expect(
      db.prisma.$transaction((tx) => db.service.verifyContinuationManifest(tx, f.user.id, current)),
    ).rejects.toThrow("User policy changed");
    expect((await db.service.get(f.user.id, attempt.id)).state).toBe("submitting");
  });
});
