import { personalRecruitingManifestSchema } from "../../packages/contracts/src/personal-recruiting";
import { recruitingFixture } from "./recruiting-builders";
import { describe, expect, test } from "bun:test";

describe("recruiting manifest", () => {
  test("preserves registration and attendance as independent facts", () => {
    const manifest = personalRecruitingManifestSchema.parse(recruitingFixture());
    expect(manifest.firms[2]!.events[0]!.registrationStatus).toBe("registered");
    expect(manifest.firms[2]!.events[0]!.attendanceStatus).toBe("unknown");
  });

  test("rejects missing references, duplicate identities and excluded firms", () => {
    const invalidRef = recruitingFixture();
    invalidRef.firms[0]!.events[0]!.evidenceIds = ["missing"];
    expect(personalRecruitingManifestSchema.safeParse(invalidRef).success).toBe(false);
    const duplicate = recruitingFixture();
    duplicate.firms[2]!.id = "bain";
    expect(personalRecruitingManifestSchema.safeParse(duplicate).success).toBe(false);
    expect(
      personalRecruitingManifestSchema.safeParse({
        ...recruitingFixture(),
        firms: [
          { ...recruitingFixture().firms[0], id: "bain_capital" },
          ...recruitingFixture().firms.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects impossible days, invalid timestamp dates and reversed events", () => {
    const invalidDate = recruitingFixture();
    invalidDate.firms[0]!.deadline.date = "2026-02-30";
    expect(personalRecruitingManifestSchema.safeParse(invalidDate).success).toBe(false);
    expect(
      personalRecruitingManifestSchema.safeParse({
        ...recruitingFixture(),
        updatedAt: "2026-02-30T12:00:00Z",
      }).success,
    ).toBe(false);
    const reversed = recruitingFixture();
    reversed.firms[0]!.events[0]!.startAt = "2026-09-23T12:00:00-04:00";
    reversed.firms[0]!.events[0]!.endAt = "2026-09-22T12:00:00-04:00";
    expect(personalRecruitingManifestSchema.safeParse(reversed).success).toBe(false);
  });

  test("rejects active URL schemes and unsupported verified deadlines", () => {
    for (const url of [
      "not a url",
      "http://",
      "javascript:alert(1)",
      "file:///private/contacts.csv",
      "https://user:secret@example.com/",
    ]) {
      const manifest = recruitingFixture();
      manifest.firms[0]!.events[0]!.url = url;
      expect(personalRecruitingManifestSchema.safeParse(manifest).success).toBe(false);
    }
    const unsupported = recruitingFixture();
    unsupported.firms[0]!.deadline.verification = "verified";
    expect(personalRecruitingManifestSchema.safeParse(unsupported).success).toBe(false);
  });
});
