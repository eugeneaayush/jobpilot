import {
  availabilitySchema,
  portfolioSettingsPatchSchema,
  setPrimaryResumeSchema,
  usernameSchema,
  userWithAutoApplySchema,
} from "./user";
import { describe, expect, it } from "bun:test";

const UUID = "3f2c3f1e-0d5c-4f6a-9b8e-1a2b3c4d5e6f";

const validUser = () => ({
  firstName: "Ada",
  lastName: "Lovelace",
  contactEmail: "ada@example.com",
  usAuthorized: true,
  requiresSponsorship: false,
  willingToRelocate: false,
  preferredLocations: ["London"],
  references: [],
  salaryPreferences: [],
});

describe("usernameSchema", () => {
  it("trims and lowercases before checking the shape", () => {
    expect(usernameSchema.parse("  Ada-Lovelace  ")).toBe("ada-lovelace");
  });

  it("bounds the slug to 3-30 characters of letters, digits, and interior hyphens", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("a".repeat(31)).success).toBe(false);
    expect(usernameSchema.safeParse("a".repeat(30)).success).toBe(true);
    expect(usernameSchema.safeParse("-ada").success).toBe(false);
    expect(usernameSchema.safeParse("ada-").success).toBe(false);
    expect(usernameSchema.safeParse("ada_lovelace").success).toBe(false);
    expect(usernameSchema.safeParse("ada2").success).toBe(true);
  });
});

describe("availabilitySchema", () => {
  it("accepts the two availability states only", () => {
    expect(availabilitySchema.safeParse("open").success).toBe(true);
    expect(availabilitySchema.safeParse("not_looking").success).toBe(true);
    expect(availabilitySchema.safeParse("away").success).toBe(false);
  });
});

describe("portfolioSettingsPatchSchema", () => {
  it("takes every field optionally", () => {
    expect(portfolioSettingsPatchSchema.parse({})).toEqual({});
  });

  it("validates username and availability when present, null clearing availability", () => {
    expect(portfolioSettingsPatchSchema.safeParse({ username: "no" }).success).toBe(false);
    expect(portfolioSettingsPatchSchema.safeParse({ username: "ada2" }).success).toBe(true);
    expect(portfolioSettingsPatchSchema.parse({ availability: null })).toEqual({
      availability: null,
    });
    expect(portfolioSettingsPatchSchema.safeParse({ availability: "away" }).success).toBe(false);
  });

  it("checks the visibility flags are booleans", () => {
    expect(portfolioSettingsPatchSchema.safeParse({ showResume: "yes" }).success).toBe(false);
    expect(portfolioSettingsPatchSchema.parse({ showGithub: true })).toEqual({ showGithub: true });
  });
});

describe("setPrimaryResumeSchema", () => {
  it("sets with a uuid and clears with null", () => {
    expect(setPrimaryResumeSchema.parse({ resumeId: UUID })).toEqual({ resumeId: UUID });
    expect(setPrimaryResumeSchema.parse({ resumeId: null })).toEqual({ resumeId: null });
    expect(setPrimaryResumeSchema.safeParse({ resumeId: "nope" }).success).toBe(false);
    expect(setPrimaryResumeSchema.safeParse({}).success).toBe(false);
  });
});

describe("userWithAutoApplySchema", () => {
  it("accepts the minimal profile and leaves absent optional fields out", () => {
    const parsed = userWithAutoApplySchema.parse(validUser());
    expect(parsed.firstName).toBe("Ada");
    expect(parsed.website).toBeUndefined();
    expect(parsed.autoApply).toBeUndefined();
  });

  it("requires the identity core: names, contact email, and the three toggles", () => {
    for (const key of [
      "firstName",
      "lastName",
      "contactEmail",
      "usAuthorized",
      "requiresSponsorship",
      "willingToRelocate",
    ]) {
      const profile: Record<string, unknown> = { ...validUser() };
      delete profile[key];
      expect(userWithAutoApplySchema.safeParse(profile).success).toBe(false);
    }
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), contactEmail: "nope" }).success,
    ).toBe(false);
  });

  it("allows the optional contact fields to be empty, null, or absent", () => {
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), phone: "", website: "", zipCode: null })
        .success,
    ).toBe(true);
    const sparse: Record<string, unknown> = {
      ...validUser(),
      linkedin: undefined,
      github: undefined,
      aptUnit: undefined,
    };
    expect(userWithAutoApplySchema.safeParse(sparse).success).toBe(true);
  });

  it("rejects website, LinkedIn, and GitHub values that are not real profile URLs", () => {
    const patched = (patch: Record<string, unknown>) =>
      userWithAutoApplySchema.safeParse({ ...validUser(), ...patch }).success;
    expect(patched({ website: "example.com" })).toBe(false);
    expect(patched({ website: "https://example.com" })).toBe(true);
    expect(patched({ linkedin: "linkedin.com/in/ada" })).toBe(false);
    expect(patched({ linkedin: "https://twitter.com/in/ada" })).toBe(false);
    expect(patched({ linkedin: "https://linkedin.com/in/ada" })).toBe(true);
    expect(patched({ github: "https://gitlab.com/ada" })).toBe(false);
    expect(patched({ github: "https://github.com/ada" })).toBe(true);
  });

  it("accepts real ZIP and postal codes and rejects short or punctuated junk", () => {
    const zip = (zipCode: string) =>
      userWithAutoApplySchema.safeParse({ ...validUser(), zipCode }).success;
    expect(zip("94103")).toBe(true);
    expect(zip("SW1A 1AA")).toBe(true);
    expect(zip("K1B 0B1")).toBe(true);
    expect(zip("9")).toBe(false);
    expect(zip("94103-")).toBe(false);
    expect(zip("-94103")).toBe(false);
    expect(zip("1234567890123")).toBe(false);
  });

  it("validates the phone as international-or-empty", () => {
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), phone: "+14155552671" }).success,
    ).toBe(true);
    expect(userWithAutoApplySchema.safeParse({ ...validUser(), phone: "555-1234" }).success).toBe(
      false,
    );
  });

  it("caps references at three and requires each name", () => {
    const reference = { name: "Charles Babbage" };
    expect(
      userWithAutoApplySchema.safeParse({
        ...validUser(),
        references: [reference, reference, reference],
      }).success,
    ).toBe(true);
    expect(
      userWithAutoApplySchema.safeParse({
        ...validUser(),
        references: [reference, reference, reference, reference],
      }).success,
    ).toBe(false);
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), references: [{ name: "" }] }).success,
    ).toBe(false);
  });

  it("caps salary preferences at five with nonnegative amounts and known currency and period", () => {
    const preference = {
      appliesTo: "Full-time backend",
      minAmount: 100000,
      currency: "USD",
      period: "yearly",
    };
    const preferences = (rows: unknown[]) =>
      userWithAutoApplySchema.safeParse({ ...validUser(), salaryPreferences: rows }).success;
    expect(preferences([preference])).toBe(true);
    expect(preferences([{ ...preference, minAmount: -1 }])).toBe(false);
    expect(preferences([{ ...preference, currency: "JPY" }])).toBe(false);
    expect(preferences([{ ...preference, period: "monthly" }])).toBe(false);
    expect(preferences([1, 2, 3, 4, 5].map(() => preference))).toBe(true);
    expect(preferences([1, 2, 3, 4, 5, 6].map(() => preference))).toBe(false);
  });

  it("takes a uuid, null, or nothing for primaryResumeId", () => {
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), primaryResumeId: UUID }).success,
    ).toBe(true);
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), primaryResumeId: null }).success,
    ).toBe(true);
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), primaryResumeId: "nope" }).success,
    ).toBe(false);
  });
});

describe("autoApply settings", () => {
  const autoApply = (patch: Record<string, unknown>) => ({
    ...validUser(),
    autoApply: { minMatchScore: 60, defaultStartDate: "2 weeks notice", ...patch },
  });

  it("requires defaultStartDate and a whole minMatchScore from 0 to 100", () => {
    expect(userWithAutoApplySchema.safeParse(autoApply({})).success).toBe(true);
    expect(
      userWithAutoApplySchema.safeParse({ ...validUser(), autoApply: { minMatchScore: 60 } })
        .success,
    ).toBe(false);
    expect(userWithAutoApplySchema.safeParse(autoApply({ minMatchScore: 0 })).success).toBe(true);
    expect(userWithAutoApplySchema.safeParse(autoApply({ minMatchScore: 100 })).success).toBe(true);
    expect(userWithAutoApplySchema.safeParse(autoApply({ minMatchScore: -1 })).success).toBe(false);
    expect(userWithAutoApplySchema.safeParse(autoApply({ minMatchScore: 101 })).success).toBe(
      false,
    );
    expect(userWithAutoApplySchema.safeParse(autoApply({ minMatchScore: 60.5 })).success).toBe(
      false,
    );
  });

  it("bounds the per-campaign cap to a whole number from 1 to 500", () => {
    expect(
      userWithAutoApplySchema.safeParse(autoApply({ maxApplicationsPerCampaign: 1 })).success,
    ).toBe(true);
    expect(
      userWithAutoApplySchema.safeParse(autoApply({ maxApplicationsPerCampaign: 500 })).success,
    ).toBe(true);
    expect(
      userWithAutoApplySchema.safeParse(autoApply({ maxApplicationsPerCampaign: 0 })).success,
    ).toBe(false);
    expect(
      userWithAutoApplySchema.safeParse(autoApply({ maxApplicationsPerCampaign: 501 })).success,
    ).toBe(false);
    expect(
      userWithAutoApplySchema.safeParse(autoApply({ maxApplicationsPerCampaign: 2.5 })).success,
    ).toBe(false);
  });
});
