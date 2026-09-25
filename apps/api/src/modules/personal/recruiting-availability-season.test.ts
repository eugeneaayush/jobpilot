import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { describe, expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({
  recruitingAvailability: {
    partTimeNow: true,
    partTimeMaxHours: 20,
    partTimeLocations: ["NYC", "US remote"],
    internshipStartMonth: "2027-05",
    internshipEndMonth: "2027-09",
    permanentStartMonth: "2028-05",
    paidOnly: true,
    englishSufficientOnly: true,
    employerSupportedInternational: true,
    unrestrictedTravelRelocation: true,
  },
});
const descriptionText =
  "This is a paid internship. You will work with our investment team and conduct research for our clients.";
const posting = {
  title: "Investment Analyst Intern (Summer 2027)",
  descriptionText,
  location: "New York, NY",
};
function availability(input = posting, candidateSettings = settings) {
  return assessRecruitingConstraints(input, candidateSettings).requirements.find(
    (item) => item.requirement === "Recruiting availability",
  )!;
}

describe("source-stated summer internship year", () => {
  test("matches a US summer title to approved May-September months without inventing dates", () => {
    const result = availability();
    expect(result.status).toBe("satisfied");
    expect(result.evidence).toBe(posting.title);
    expect(result.candidateEvidence).toContain(
      "exact employer dates and boundary days unconfirmed",
    );
    expect(availability({ ...posting, title: "2027 Summer MBA Intern" }).status).toBe("satisfied");
  });
  test("does not satisfy a narrower or missing candidate window", () => {
    for (const interval of [
      { internshipStartMonth: "2027-06", internshipEndMonth: "2027-08" },
      { internshipStartMonth: null, internshipEndMonth: null },
    ]) {
      const candidate = personalSettingsSchema.parse({
        ...settings,
        recruitingAvailability: { ...settings.recruitingAvailability, ...interval },
      });
      expect(availability(posting, candidate).status).toBe("unknown");
    }
  });
  test("rejects a different non-overlapping summer year", () => {
    expect(availability({ ...posting, title: "MBA Intern (Summer 2028)" }).status).toBe("violated");
  });
  test("does not assume a country or hemisphere from the summer label", () => {
    for (const location of ["Remote", "Worldwide", "Sydney, Australia", "London, United Kingdom"])
      expect(availability({ ...posting, location }).status).toBe("unknown");
  });
  test("ambiguous years or an absent title year remain unknown", () => {
    for (const title of ["MBA Intern (Summer)", "MBA Intern Summer 2027 / Summer 2028"])
      expect(availability({ ...posting, title }).status).toBe("unknown");
  });
  test("description-only summer references do not establish the role's season", () => {
    expect(
      availability({
        ...posting,
        title: "MBA Intern",
        descriptionText: `${descriptionText} Our prior summer 2027 program was successful.`,
      }).status,
    ).toBe("unknown");
  });
  test("explicit employer date ranges take precedence over the title", () => {
    expect(
      availability({
        ...posting,
        descriptionText: `${descriptionText} This internship runs from June 2027 to October 2027.`,
      }).status,
    ).toBe("violated");
    expect(
      availability({
        ...posting,
        descriptionText: `${descriptionText} This internship runs from May 1, 2027 to September 30, 2027.`,
      }).status,
    ).toBe("unknown");
  });
  test("an incomplete dated schedule cannot be overwritten by seasonal title evidence", () => {
    expect(
      availability({
        ...posting,
        descriptionText: `${descriptionText} This internship starts in October 2027.`,
      }).status,
    ).toBe("unknown");
  });
  test("application and interview schedules do not replace the title's employment season", () => {
    expect(
      availability({
        ...posting,
        descriptionText: `${descriptionText} Applications start in October 2026. Interviews run from November 2026 to December 2026.`,
      }).status,
    ).toBe("satisfied");
  });
});
