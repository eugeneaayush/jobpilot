import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { jurisdictionWorkAuthorization } from "./work-authorization";
import { describe, expect, test } from "bun:test";

describe("jurisdiction-specific work authorization", () => {
  test("settings preserve countries and non-exact availability without inferring sponsorship", () => {
    const settings = personalSettingsSchema.parse({
      workAuthorization: true,
      workAuthorizationCountries: [" us "],
      availabilityNotes: "Part-time now; full-time summer 2027",
    });
    expect(settings.workAuthorizationCountries).toEqual(["US"]);
    expect(settings.requiresSponsorship).toBeNull();
    expect(settings.availableFrom).toBeNull();
    expect(settings.availableUntil).toBeNull();
    expect(personalSettingsSchema.parse({}).workAuthorizationCountries).toEqual([]);
  });
  test("explicit US authorization can satisfy known US cities, states and country locations", () => {
    for (const location of [
      "New York",
      "NYC",
      "Seattle, WA",
      "Remote - US",
      "Boston, Massachusetts",
      "San Francisco, CA, USA",
      "Chicago; Houston",
      "United States",
    ])
      expect(
        jurisdictionWorkAuthorization(location, "Must be authorized to work", true, ["US"]),
      ).toBe(true);
  });
  test("legacy global booleans and unknown, mixed or foreign locations stay unknown", () => {
    expect(jurisdictionWorkAuthorization("New York", "", true, [])).toBeUndefined();
    for (const location of [
      null,
      "",
      "Remote",
      "Worldwide",
      "London",
      "Toronto, Canada",
      "New York / London",
      "NYC; unspecified",
      "New York, unspecified",
      "NYC or Remote",
      "Boston, MA | Toronto, Canada",
      "Georgia",
      "CA",
    ])
      expect(
        jurisdictionWorkAuthorization(location, "Must be authorized to work in the US", true, [
          "US",
        ]),
      ).toBeUndefined();
    expect(
      jurisdictionWorkAuthorization("New York; London", "", true, ["US", "GB"]),
    ).toBeUndefined();
  });
  test("a conflicting explicit requirement cannot use a location-derived answer", () => {
    expect(
      jurisdictionWorkAuthorization("New York", "Must be authorized to work in Canada", true, [
        "US",
      ]),
    ).toBeUndefined();
    expect(
      jurisdictionWorkAuthorization("New York", "Must be authorized in the US and Canada", true, [
        "US",
        "CA",
      ]),
    ).toBeUndefined();
  });
  test("a known negative applies only to its explicitly supplied jurisdiction", () => {
    expect(jurisdictionWorkAuthorization("New York", "", false, ["US"])).toBe(false);
    expect(jurisdictionWorkAuthorization("London", "", false, ["US"])).toBeUndefined();
  });
  test("non-US authorization requires its own explicit country and does not infer sponsorship", () => {
    expect(jurisdictionWorkAuthorization("Toronto, Canada", "", true, ["CA"])).toBe(true);
    const result = evaluatePosting(
      {
        title: "Intern",
        employer: "Synthetic",
        location: "New York",
        deadline: null,
        descriptionText: "Must be authorized to work in the US. No sponsorship available.",
      },
      { workAuthorized: true, workAuthorizationCountries: ["US"] },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.requirements.find((r) => r.requirement === "Work authorization")?.status).toBe(
      "satisfied",
    );
    expect(
      result.requirements.find((r) => r.requirement === "No sponsorship required")?.status,
    ).toBe("unknown");
    expect(result.eligibility).toBe("unknown");
  });
});
