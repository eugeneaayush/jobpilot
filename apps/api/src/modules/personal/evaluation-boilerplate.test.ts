import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

const evaluate = (descriptionText: string) =>
  evaluatePosting(
    {
      title: "Summer 2027 MBA Research Analyst Intern",
      descriptionText,
      employer: "Example Investment Management",
      location: "New York, NY",
      deadline: null,
    },
    {
      mbaEnrolled: true,
      mbaGraduationYear: 2028,
      workAuthorized: true,
      workAuthorizationCountries: ["US"],
      sponsorshipRequired: false,
    },
    {},
    EMPTY_RESUME_DATA,
  );
const qualification = "Currently pursuing an MBA graduating in 2028.";
const salary = "Salary Range: $12,000-$14,500 USD Monthly";
const salaryFactors =
  "The actual base salary may vary depending on factors, including, but not limited to location, work experience, education, training, skill level, and market conditions.";
const employerStatement =
  "Example Investment Management is an affirmative action and equal opportunity employer.";
const culture =
  "We value diverse perspectives and are committed to building an inclusive environment where all employees can thrive.";
const accommodation =
  "For a reasonable accommodation request, please contact careers@example.invalid.";

describe("qualification sections ending in employer boilerplate", () => {
  test("salary range terminates the qualification list without turning pay or culture into requirements", () => {
    const result = evaluate(
      [
        "Requirements",
        "Who You Are:",
        qualification,
        "Must be able to be on-site at our New York office Monday-Thursdays with the option to come in Fridays as well.",
        salary,
        salaryFactors,
        "At this time, Example Investment Management will not sponsor an applicant for employment authorization for this position.",
        "Working at Example Investment Management",
        employerStatement,
        culture,
        "We welcome and encourage candidates from all backgrounds and experiences to join our team.",
        "To be considered for this role, applicants must be authorized to work for any employer in the U.S.",
        "We are unable to sponsor or assume sponsorship of an employment Visa at this time.",
        accommodation,
      ].join("\n"),
    );
    expect(result.requirements.filter((item) => item.evidence === qualification)).toHaveLength(2);
    expect(
      result.requirements.filter((item) => item.requirement === "No sponsorship required"),
    ).toHaveLength(2);
    expect(
      result.requirements.find((item) => item.requirement === "Work authorization")?.status,
    ).toBe("satisfied");
    expect(result.requirements.filter((item) => item.status === "unknown")).toEqual([
      expect.objectContaining({ evidence: expect.stringContaining("on-site at our New York") }),
    ]);
  });
  test("each clear boilerplate boundary works even without a salary-range heading", () => {
    for (const boundary of [
      salaryFactors,
      "Working at Example Investment Management",
      employerStatement,
      accommodation,
    ]) {
      const result = evaluate(`Requirements\n${qualification}\n${boundary}\n${culture}`);
      expect(result.requirements.every((item) => item.evidence === qualification)).toBe(true);
      expect(result.eligibility).toBe("eligible");
    }
  });
  test("explicit mandatory qualifications remain unknown after or within pay prose", () => {
    const unknown = "Applicants must have expertise in derivatives.";
    for (const separator of ["\n", ". "]) {
      const result = evaluate(`Requirements\n${qualification}\n${salary}${separator}${unknown}`);
      expect(result.requirements.find((item) => item.evidence === unknown)?.status).toBe("unknown");
      expect(result.eligibility).toBe("unknown");
    }
  });
  test("employer boilerplate does not swallow a mandatory condition in the same paragraph", () => {
    const unknown = "Applicants must hold an active professional license.";
    const result = evaluate(`Requirements\n${qualification}\n${employerStatement} ${unknown}`);
    expect(result.requirements.find((item) => item.evidence === unknown)?.status).toBe("unknown");
  });
  test("an actual qualification after a renewed requirements heading remains unknown", () => {
    const unknown = "Strong financial modelling and analytical judgment";
    const result = evaluate(`Requirements\n${qualification}\n${salary}\nRequirements\n${unknown}`);
    expect(result.requirements.find((item) => item.evidence === unknown)?.status).toBe("unknown");
  });
  test("similarly worded actual qualifications are not boilerplate boundaries", () => {
    for (const unknown of [
      "Salary analysis experience",
      "Working at a registered investment adviser requires an active professional license.",
    ]) {
      const result = evaluate(`Requirements\n${qualification}\n${unknown}`);
      expect(result.requirements.find((item) => item.evidence === unknown)?.status).toBe("unknown");
    }
  });
});
