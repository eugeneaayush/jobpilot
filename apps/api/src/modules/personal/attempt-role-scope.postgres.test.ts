import { eligibilityContext } from "./eligibility-freshness";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { jsonValue, objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("campaign role scope at the PostgreSQL submit boundary", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  async function fixture() {
    const f = await personalFixture(db);
    const policy = {
      ...objectValue(objectValue(f.campaign.config).personal),
      tracks: ["mba_internship", "general_professional"],
      sources: { boardTokens: ["synthetic"] },
      roleScope: { internshipOnly: true, categories: ["tech_product_management"] },
    };
    await db.prisma.campaign.update({
      where: { campaignId: f.campaign.campaignId },
      data: { config: { personal: policy } },
    });
    const r = await f.record();
    const record = await db.prisma.personalRecord.update({
      where: { id: r.record.id },
      data: { title: "Technical Product Manager Intern", track: "general_professional" },
    });
    const evaluated = await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...objectValue(record.details),
          eligibilityContext: eligibilityContext(record, {
            settings: f.settings,
            evidence: f.resume,
          }),
        }),
      },
    });
    return { ...f, ...r, record: evaluated, policy };
  }

  it("blocks direct start outside the configured role scope", async () => {
    const f = await fixture();
    await db.prisma.personalRecord.update({
      where: { id: f.record.id },
      data: { title: "Full-time Technical Product Manager" },
    });
    await expect(db.service.start(f.user.id, f.input)).rejects.toThrow("not an internship");
    expect(await db.prisma.personalAttempt.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await db.prisma.personalReservation.count({ where: { userId: f.user.id } })).toBe(0);
  });

  it("blocks a title mutation between preparation and final submit", async () => {
    const f = await fixture();
    const attempt = await db.service.start(f.user.id, f.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    await db.prisma.personalRecord.update({
      where: { id: f.record.id },
      data: { title: "Full-time Technical Product Manager" },
    });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "Recruiting constraint needs current source review",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
  });

  it("freezes the role scope and disallows removing it after preparation", async () => {
    const f = await fixture();
    const attempt = await db.service.start(f.user.id, f.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    const { roleScope: _scope, ...policy } = f.policy;
    await db.prisma.campaign.update({
      where: { campaignId: f.campaign.campaignId },
      data: { config: { personal: policy } },
    });
    await expect(db.service.beginSubmit(f.user.id, attempt.id, attempt)).rejects.toThrow(
      "Campaign policy changed",
    );
    expect((await db.service.get(f.user.id, attempt.id)).submitAt).toBeNull();
  });

  it("requires scoped records to match the configured source and track", async () => {
    const f = await fixture();
    await db.prisma.personalRecord.update({
      where: { id: f.record.id },
      data: { track: "post_mba_fulltime" },
    });
    await expect(db.service.start(f.user.id, f.input)).rejects.toThrow("Track is outside");
    await db.prisma.personalRecord.update({
      where: { id: f.record.id },
      data: { track: "general_professional", identity: "greenhouse:outside:123" },
    });
    await expect(db.service.start(f.user.id, f.input)).rejects.toThrow("Source is outside");
  });

  it("permits a non-MBA internship through the same final-submit guard", async () => {
    const f = await fixture();
    const attempt = await db.service.start(f.user.id, f.input);
    await db.service.prepare(f.user.id, attempt.id, attempt);
    const begun = await db.service.beginSubmit(f.user.id, attempt.id, attempt);
    expect(begun.state).toBe("submitting");
    expect(begun.submitAt).not.toBeNull();
    expect(objectValue(begun.manifest).policy).toMatchObject({ roleScope: f.policy.roleScope });
  });
});
