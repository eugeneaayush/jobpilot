import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import { verifyRecruitingConstraints } from "./graduate-eligibility-policy";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { describe, expect, test } from "bun:test";

function settings(employerSupportedInternational: boolean) {
  return personalSettingsSchema.parse({
    recruitingAvailability: {
      partTimeNow: true,
      partTimeMaxHours: 20,
      partTimeLocations: ["NYC", "US remote"],
      internshipStartMonth: "2027-05",
      internshipEndMonth: "2027-09",
      permanentStartMonth: "2028-05",
      paidOnly: true,
      englishSufficientOnly: true,
      employerSupportedInternational,
      unrestrictedTravelRelocation: true,
    },
    workAuthorization: true,
    workAuthorizationCountries: ["US"],
    citizenship: "US",
  });
}
function posting(location: string | null, sponsored = false) {
  return {
    title: "MBA internship",
    location,
    descriptionText:
      "This is a paid internship. The internship runs from June 2027 to August 2027. You will work with our team and conduct research for our clients." +
      (sponsored ? " The company will provide visa sponsorship." : ""),
  };
}

describe("jurisdiction-bound recruiting authorization", () => {
  test("disabling international routes never bypasses unknown work authorization", () => {
    for (const location of ["London", null, "Remote", "Worldwide", "New York / London"])
      for (const sponsored of [true, false]) {
        const result = assessRecruitingConstraints(posting(location, sponsored), settings(false));
        expect(result.decision).toBe("unknown");
        expect(result.requirements).toContainEqual(
          expect.objectContaining({ requirement: "Work authorization", status: "unknown" }),
        );
      }
  });
  test("accepts explicit existing authorization in a matching country with either route setting", () => {
    for (const enabled of [true, false])
      for (const [location, country] of [
        ["New York", "US"],
        ["London", "GB"],
      ] as const) {
        const result = assessRecruitingConstraints(posting(location), {
          ...settings(enabled),
          workAuthorizationCountries: [country],
        });
        expect(result.decision).toBe("satisfied");
        expect(
          result.requirements.some(
            (item) => item.requirement === "Employer-supported international route",
          ),
        ).toBe(false);
      }
  });
  test("US location requires a known scoped authorization answer with either route setting", () => {
    for (const enabled of [true, false]) {
      for (const facts of [{ workAuthorization: null }, { workAuthorizationCountries: [] }]) {
        const result = assessRecruitingConstraints(posting("New York"), {
          ...settings(enabled),
          ...facts,
        });
        expect(result.decision).toBe("unknown");
      }
      const result = assessRecruitingConstraints(posting("New York"), {
        ...settings(enabled),
        workAuthorization: false,
      });
      expect(result.decision).toBe("violated");
    }
  });
  test("preserves an explicitly supported international route without inventing authorization", () => {
    const result = assessRecruitingConstraints(posting("London", true), settings(true));
    expect(result.decision).toBe("satisfied");
    expect(result.requirements).toContainEqual(
      expect.objectContaining({
        requirement: "Employer-supported international route",
        status: "satisfied",
      }),
    );
    expect(
      result.requirements.some(
        (item) => item.requirement === "Work authorization" && item.status === "satisfied",
      ),
    ).toBe(false);
  });
  test("submission rechecks a saved eligible record when the international route is disabled", () => {
    const source = posting("London", true);
    expect(() =>
      verifyRecruitingConstraints(
        {
          id: "synthetic-record",
          identity: "greenhouse:synthetic:1",
          title: source.title,
          company: "Synthetic",
          updatedAt: new Date("2026-09-20T12:00:00Z"),
          details: { posting: source, eligibility: { decision: "eligible" } },
        } as unknown as PersonalRecord,
        settings(false),
        {
          id: "synthetic-resume",
          sourceHash: "a".repeat(64),
          details: { conflicts: [] },
        } as unknown as PersonalResumeEvidence,
      ),
    ).toThrow("current source review");
  });
});
