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
const schedule =
  "10-week paid program, annualized $185K+ base salary.\nInternship Start: Early June 2027";
function requirement(
  descriptionText: string,
  name = "Recruiting availability",
  title = "MBA Internship",
) {
  return assessRecruitingConstraints(
    { title, descriptionText, location: "New York, NY" },
    settings,
  ).requirements.find((item) => item.requirement === name)!;
}

describe("source-stated internship start month and fixed duration", () => {
  test("bounds every possible start day and retains the exact source clauses", () => {
    const result = requirement(schedule);
    expect(result.status).toBe("satisfied");
    expect(result.evidence).toBe(schedule);
    expect(result.candidateEvidence).toContain("bounded inference");
    expect(result.candidateEvidence).toContain("2027-06 start and 10-week duration");
    expect(result.candidateEvidence).toContain("every possible day of the start month");
    expect(result.candidateEvidence).toContain(
      "exact employer dates and boundary days unconfirmed",
    );
    expect(result.candidateEvidence).not.toMatch(/2027-\d{2}-\d{2}/);
  });

  test("accepts envelopes entirely within the approved boundary months", () => {
    for (const text of [
      "Internship Start: May 2027. This is a 10-week internship.",
      "Internship starts in June 2027. Our internship lasts 13 weeks.",
      "Internship begins in July 2027. This is an 8-week program.",
      "Internship Start: Early June 2027. This is a 10-week paid program.",
    ])
      expect(requirement(text).status).toBe("satisfied");
  });

  test("early or exact start wording cannot shrink the month envelope to fit", () => {
    for (const text of [
      "Internship Start: Early July 2027. This is a 9-week internship.",
      "Internship Start: July 1, 2027. This is a 9-week internship.",
      "Internship Start: June 2027. This is a 14-week internship.",
      "Internship Start: April 2027. This is a 10-week internship.",
      "Internship Start: October 2027. This is a 10-week internship.",
    ])
      expect(requirement(text).status).toBe("unknown");
  });

  test("missing, non-fixed, and conflicting durations remain unknown even with a summer title", () => {
    for (const duration of [
      "",
      "The internship duration will be confirmed.",
      "This is an 8-10-week internship.",
      "This is an approximately 10-week internship.",
      "The internship lasts at least 10 weeks.",
      "This is a 10-week internship. Our internship lasts 12 weeks.",
      "This is a 0-week internship.",
      "This is a 10-week internship with a possible extension.",
      "This is a 10-week internship that could last 20 weeks.",
    ])
      expect(
        requirement(`Internship Start: June 2027. ${duration}`, undefined, "Summer 2027 MBA Intern")
          .status,
      ).toBe("unknown");
  });

  test("conflicting and conditional start evidence stays unknown", () => {
    for (const start of [
      "Internship Start: June 2027. Internship Start: July 2027.",
      "Internship starts in June 2027 or October 2027.",
      "Internship Start: Early June 2027. Internship Start: Late June 2027.",
      "Internship Start: June 2027. Our program starts in autumn 2027.",
      "Internship Start: Tentative June 2027.",
      "Internship does not start in June 2027.",
      "Internship Start: June 2027. The internship does not start in June 2027.",
      "Internship Start: June 31, 2027.",
    ])
      expect(requirement(`${start} This is a 10-week internship.`).status).toBe("unknown");
  });

  test("unrelated timelines cannot supply either half of an internship schedule", () => {
    for (const text of [
      "Application deadline: June 2027. This is a 10-week internship.",
      "Graduation: June 2027. This is a 10-week internship.",
      "Interviews: Internship Start June 2027. This is a 10-week internship.",
      "Our other program starts in June 2027. This is a 10-week internship.",
      "Internship Start: June 2027. Our other program is a 10-week program.",
      "Internship Start: June 2027. This is a 10-week training program.",
      "Internship Start: June 2027. Our prior internship lasts 10 weeks.",
      "Internship Start: June 2027. Our Executive Academy program lasts 10 weeks.",
    ])
      expect(requirement(text).status).toBe("unknown");
  });

  test("unrelated schedules do not conflict with a complete supported schedule", () => {
    const unrelated =
      "Application deadline: March 2027. Interviews run from April 2027 to May 2027. Graduation expected May 2028. Our other program runs from October 2027 to December 2027 and lasts 20 weeks.";
    expect(requirement(`${schedule}\n${unrelated}`).status).toBe("satisfied");
  });

  test("an explicit employment interval continues to take precedence", () => {
    expect(
      requirement(`${schedule}\nThe internship runs from June 2027 to October 2027.`).status,
    ).toBe("violated");
  });

  test("missing candidate months do not allow bounded inference", () => {
    const candidate = personalSettingsSchema.parse({
      ...settings,
      recruitingAvailability: { ...settings.recruitingAvailability, internshipEndMonth: null },
    });
    expect(
      assessRecruitingConstraints(
        { title: "MBA Intern", descriptionText: schedule, location: "New York, NY" },
        candidate,
      ).requirements.find((item) => item.requirement === "Recruiting availability")?.status,
    ).toBe("unknown");
  });
});

describe("paid program with monetary base salary", () => {
  test("retains affirmative annualized monetary salary evidence", () => {
    const result = requirement(schedule, "Paid compensation");
    expect(result.status).toBe("satisfied");
    expect(result.evidence).toBe("10-week paid program, annualized $185K+ base salary.");
  });

  test("paid time off, unspecified pay, and other monetary amounts are not salary", () => {
    for (const text of [
      "10-week program with paid time off and benefits.",
      "10-week paid program, base salary to be discussed.",
      "10-week program with paid time off, annualized $185K+ base salary.",
      "10-week paid program with a $185K investment fund.",
      "10-week paid program, annualized $0 base salary.",
      "Our prior program was a paid program, annualized $185K+ base salary.",
    ])
      expect(requirement(text, "Paid compensation").status).toBe("unknown");
  });

  test("negated pay does not turn into affirmative compensation", () => {
    for (const text of [
      "This is not a paid program, annualized $185K+ base salary.",
      "10-week unpaid program, annualized $185K+ base salary.",
      "10-week paid program without base salary.",
      "No paid program, annualized $185K+ base salary.",
    ])
      expect(requirement(text, "Paid compensation").status).toBe("violated");
    expect(
      requirement(
        "We do not offer a paid program, annualized $185K+ base salary.",
        "Paid compensation",
      ).status,
    ).toBe("unknown");
  });
});
