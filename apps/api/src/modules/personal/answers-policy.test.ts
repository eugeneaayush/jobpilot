import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { screeningSuggestions } from "./answers-policy";
import { describe, expect, it } from "bun:test";

const settings = personalSettingsSchema.parse({
  workAuthorization: true,
  workAuthorizationCountries: ["US"],
  requiresSponsorship: false,
  availableFrom: "2027-06-01",
  yearsExperience: 7,
  minimumCompensation: 100,
  screeningDefaults: {
    skillExperience: [
      { skill: "SQL", years: 2 },
      { skill: "C++", years: 1 },
    ],
    desiredCompensation: { amount: 150000, currency: "USD", period: "year" },
    willingToRelocate: false,
    voluntaryDemographics: "decline",
  },
});
const suggest = (label: string, location = "New York, NY") =>
  screeningSuggestions(
    [{ label, fieldName: "synthetic", type: "text", required: true }],
    settings,
    location,
  )[0]!;
describe("source-bound screening defaults", () => {
  it("keeps authorization and sponsorship polarity independent and jurisdiction-scoped", () => {
    expect(suggest("Are you authorized to work?").answer?.value).toBe(true);
    expect(suggest("Do you require sponsorship?").answer?.value).toBe(false);
    expect(suggest("Can you work without sponsorship?").answer).toBeNull();
    expect(suggest("Do you not require sponsorship?").answer).toBeNull();
    expect(suggest("Are you authorized to work?", "London, UK").answer).toBeNull();
  });
  it("does not substitute total experience for skill-specific years", () => {
    expect(suggest("How many years of professional experience do you have?").answer?.value).toBe(
      "7",
    );
    expect(suggest("How many years of SQL experience do you have?").answer?.value).toBe("2");
    expect(suggest("How many years of experience with C++?").answer?.value).toBe("1");
    expect(suggest("How many years of Python experience do you have?").answer).toBeNull();
    expect(suggest("How many years of SQL and Python experience do you have?").answer).toBeNull();
  });
  it("requires matching desired salary currency and period without using the minimum", () => {
    expect(suggest("Desired annual salary USD").answer?.value).toBe("150000");
    for (const label of [
      "Expected salary",
      "Desired hourly salary USD",
      "Desired annual salary EUR",
      "Current annual salary USD",
      "Desired annual or hourly salary USD",
    ])
      expect(suggest(label).answer).toBeNull();
  });
  it("keeps exact relocation and date preferences and holds declarations and demographics", () => {
    expect(suggest("Are you willing to relocate?").answer?.value).toBe(false);
    expect(suggest("When are you available to start work?").answer?.value).toBe("2027-06-01");
    expect(suggest("Availability in hours per week").answer).toBeNull();
    expect(suggest("I certify that these answers are accurate").category).toBe("consent");
    expect(suggest("I agree to terms").answer).toBeNull();
    expect(suggest("Voluntary gender self-identification").answer).toBeNull();
    expect(suggest("Voluntary gender self-identification").reason).toContain(
      "exact offered decline",
    );
  });
  it("never manufactures a source for missing values", () => {
    const answers = screeningSuggestions(
      [
        {
          label: "How many years of SQL experience do you have?",
          fieldName: "sql",
          type: "text",
          required: true,
        },
      ],
      personalSettingsSchema.parse({}),
      null,
    );
    expect(answers[0]?.answer).toBeNull();
    expect(settings.screeningDefaults!.skillExperience).toHaveLength(2);
  });
});
