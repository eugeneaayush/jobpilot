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
  workAuthorization: true,
  workAuthorizationCountries: ["US"],
  citizenship: "US",
});
const posting = (descriptionText: string, title = "MBA Intern", location = "New York, NY") => ({
  title,
  location,
  descriptionText,
});
const base =
  "This is a paid internship. The internship runs from June 2027 to August 2027. You will work with our investment team and conduct research for our clients.";
function assessment(descriptionText = base, title?: string, location?: string) {
  return assessRecruitingConstraints(posting(descriptionText, title, location), settings);
}
function requirement(result: ReturnType<typeof assessment>, name: string) {
  return result.requirements.find((item) => item.requirement === name);
}

test("multi-line compensation zones retain exact employer pay evidence", () => {
  const source =
    "The expected hourly range for this role is based on its location.\nZone 1 (New York, NY)\n$38 &mdash; $38 USD";
  const paid = requirement(assessment(source), "Paid compensation");
  expect(paid?.status).toBe("satisfied");
  expect(source).toContain(paid!.evidence);
  expect(
    requirement(
      assessment("Our fund invests $38 million USD. Market competitive compensation."),
      "Paid compensation",
    )?.status,
  ).toBe("unknown");
  expect(
    requirement(assessment(`${source}\nThis is an unpaid internship.`), "Paid compensation")
      ?.status,
  ).toBe("violated");
});

describe("approved recruiting availability", () => {
  test("accepts source-supported internship months inside the approved window", () => {
    expect(assessment().decision).toBe("satisfied");
    expect(requirement(assessment(), "Recruiting availability")?.candidateEvidence).toContain(
      "2027-05",
    );
  });
  test("holds summer-only dates and missing dates", () => {
    for (const source of [
      "This is a paid internship for Summer 2027.",
      "This is a paid internship.",
    ])
      expect(requirement(assessment(source), "Recruiting availability")?.status).toBe("unknown");
  });
  test("rejects internships extending outside approved months", () => {
    expect(
      requirement(
        assessment(base.replace("August 2027", "October 2027")),
        "Recruiting availability",
      )?.status,
    ).toBe("violated");
  });
  test("does not infer exact availability on a boundary day", () => {
    const source = base.replace("June 2027 to August 2027", "May 1, 2027 to September 30, 2027");
    expect(requirement(assessment(source), "Recruiting availability")?.status).toBe("unknown");
  });
  test("does not treat an application deadline range as employment dates", () => {
    const source =
      "This is a paid internship. Applications are open from June 2027 to August 2027.";
    expect(requirement(assessment(source), "Recruiting availability")?.status).toBe("unknown");
  });
  test("accepts permanent employment from the approved month", () => {
    const source =
      "This full-time position has a base salary of $150,000 per year. The role starts in June 2028. You will lead our product team and own the roadmap.";
    expect(assessment(source, "Product Manager").decision).toBe("satisfied");
    expect(
      requirement(
        assessment(source.replace("June 2028", "March 2028"), "Product Manager"),
        "Recruiting availability",
      )?.status,
    ).toBe("violated");
  });
  test("holds full-time immediate or unspecified start dates", () => {
    const source =
      "This is a full-time paid role available immediately. You will own the product roadmap and manage the team.";
    expect(
      requirement(assessment(source, "Product Manager"), "Recruiting availability")?.status,
    ).toBe("unknown");
  });
  test("accepts current part-time work at no more than 20 hours in NYC or US remote", () => {
    const source =
      "This is a paid part-time role for 10-20 hours per week starting immediately. You will work with the investment team and prepare research.";
    for (const location of ["New York, NY", "Remote - United States"])
      expect(assessment(source, "Investment Associate", location).decision).toBe("satisfied");
  });
  test("rejects an excessive part-time maximum and an outside location", () => {
    const source =
      "This is a paid part-time role for 25 hours per week. You will lead the investment team and prepare research.";
    expect(requirement(assessment(source, "Investment Associate"), "Part-time hours")?.status).toBe(
      "violated",
    );
    expect(
      requirement(
        assessment(source.replace("25 hours", "20 hours"), "Investment Associate", "Boston, MA"),
        "Part-time location",
      )?.status,
    ).toBe("violated");
  });
  test("holds unspecified part-time hours and a remote location without a country", () => {
    const source =
      "This is a paid part-time role. You will lead the investment team and prepare research.";
    expect(
      requirement(assessment(source, "Investment Associate", "Remote"), "Part-time hours")?.status,
    ).toBe("unknown");
    expect(
      requirement(assessment(source, "Investment Associate", "Remote"), "Part-time location")
        ?.status,
    ).toBe("unknown");
  });
  test("holds minimum-only hours and mixed employment locations", () => {
    const source =
      "This is a paid part-time role requiring at least 20 hours per week. You will lead our team and prepare investment research.";
    expect(requirement(assessment(source, "Investment Associate"), "Part-time hours")?.status).toBe(
      "unknown",
    );
    expect(
      requirement(
        assessment(source.replace("at least ", ""), "Investment Associate", "New York or London"),
        "Part-time location",
      )?.status,
    ).toBe("unknown");
  });
  test("an unrelated program schedule cannot establish internship availability", () => {
    const source =
      "This is a paid internship. Interview dates run from June 2027 to August 2027. You will work with our team to prepare investment research.";
    expect(requirement(assessment(source), "Recruiting availability")?.status).toBe("unknown");
  });
  test("a full-time role cannot use an ancillary part-time program to claim current availability", () => {
    const source =
      "This is a full-time paid role. We also offer part-time programs for 20 hours per week. You will work with our team and prepare research.";
    expect(
      requirement(assessment(source, "Full-Time Product Manager"), "Recruiting availability")
        ?.status,
    ).toBe("unknown");
  });
});

describe("paid, language, and international evidence", () => {
  test("rejects unpaid and commission-only work", () => {
    for (const phrase of ["unpaid internship", "commission-only internship"])
      expect(
        requirement(assessment(base.replace("paid internship", phrase)), "Paid compensation")
          ?.status,
      ).toBe("violated");
  });
  test("negated pay cannot become affirmative compensation", () => {
    expect(
      requirement(
        assessment(base.replace("a paid internship", "not a paid internship")),
        "Paid compensation",
      )?.status,
    ).toBe("violated");
  });
  test("zero stated compensation does not satisfy paid-only scope", () => {
    const source = base.replace("This is a paid internship.", "The salary is $0 per hour.");
    expect(requirement(assessment(source), "Paid compensation")?.status).toBe("violated");
  });
  test("does not mistake paid time off or an unpriced salary discussion for confirmed pay", () => {
    for (const phrase of ["internship with paid time off", "internship; salary will be discussed"])
      expect(
        requirement(assessment(base.replace("paid internship", phrase)), "Paid compensation")
          ?.status,
      ).toBe("unknown");
  });
  test("accepts English posting prose as a source constraint without asserting candidate fluency", () => {
    const language = requirement(assessment(), "English sufficiency");
    expect(language?.status).toBe("satisfied");
    expect(language?.candidateEvidence).toBe(
      "No additional language requirement observed in English posting",
    );
  });
  test("holds an additional required foreign language but permits an optional one", () => {
    expect(
      requirement(assessment(`${base} Fluency in Mandarin is required.`), "English sufficiency")
        ?.status,
    ).toBe("unknown");
    expect(
      requirement(assessment(`${base} Spanish is a plus.`), "English sufficiency")?.status,
    ).toBe("satisfied");
  });
  test("essential foreign-language wording remains a hold", () => {
    expect(
      requirement(
        assessment(`${base} German language skills are essential.`),
        "English sufficiency",
      )?.status,
    ).toBe("unknown");
  });
  test("holds non-English prose without affirmative English sufficiency", () => {
    const source =
      "Stage rémunéré. Nous recherchons des étudiants pour notre équipe. Le candidat doit préparer des analyses financières.";
    expect(requirement(assessment(source), "English sufficiency")?.status).toBe("unknown");
  });
  test("holds an international location with no verified employer route", () => {
    expect(
      requirement(
        assessment(base, "MBA Intern", "London, United Kingdom"),
        "Employer-supported international route",
      )?.status,
    ).toBe("unknown");
  });
  test("worldwide or country-free remote locations cannot inherit a generic sponsorship promise", () => {
    for (const location of ["Worldwide", "Remote"])
      expect(
        requirement(
          assessment(
            `${base} Visa sponsorship is available for this role.`,
            "MBA Intern",
            location,
          ),
          "Employer-supported international route",
        )?.status,
      ).toBe("unknown");
  });
  test("records sponsorship as a route, never as existing foreign work authorization", () => {
    const result = assessment(
      `${base} Visa sponsorship is available for this role.`,
      "MBA Intern",
      "London, United Kingdom",
    );
    expect(requirement(result, "Employer-supported international route")?.status).toBe("satisfied");
    expect(
      result.requirements.some(
        (item) => item.requirement === "Work authorization" && item.status === "satisfied",
      ),
    ).toBe(false);
  });
  test("requires explicit candidate citizenship and holds foreign citizenship restrictions", () => {
    const source = `${base} Visa sponsorship is available for this role.`;
    const missing = assessRecruitingConstraints(
      posting(source, "MBA Intern", "London, United Kingdom"),
      { ...settings, citizenship: null },
    );
    expect(requirement(missing, "Employer-supported international route")?.status).toBe("unknown");
    const restricted = assessment(
      `${source} Candidates must be UK citizens.`,
      "MBA Intern",
      "London, United Kingdom",
    );
    expect(requirement(restricted, "Employer-supported international route")?.status).toBe(
      "unknown",
    );
  });
  test("retains exact posting evidence for every resolved requirement", () => {
    const source = posting(base);
    for (const item of assessRecruitingConstraints(source, settings).requirements)
      expect(
        [source.title, source.descriptionText, source.location].some((text) =>
          text.includes(item.evidence),
        ),
      ).toBe(true);
  });
});
