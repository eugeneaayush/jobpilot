import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

const evaluate = (descriptionText: string, title = "MBA Intern (Class of 2028)") =>
  evaluatePosting(
    {
      title,
      descriptionText,
      employer: "Synthetic Employer",
      location: "New York, NY",
      deadline: null,
    },
    { mbaGraduationYear: 2028, mbaEnrolled: true, sponsorshipRequired: false },
    {},
    EMPTY_RESUME_DATA,
  );

describe("public recruiting copy boundaries", () => {
  test.each([
    "Benefits & Compensation for MBA Interns",
    "Benefits for Full-Time Members of Management",
  ])("%s ends qualifications while explicit restrictions after benefits remain visible", (heading) => {
    const subjective = "You thrive in ambiguity and lead through collaboration.";
    const skill = "Applicants must have advanced SQL knowledge.";
    const result = evaluate(
      [
        "Who You Are",
        subjective,
        heading,
        "Signing bonus and summer stipend",
        "Paid parental leave",
        "Equal Opportunity Employer",
        "We are proud to be an Equal Opportunity Employer.",
        "We do not make employment decisions based on citizenship status or other protected groups.",
        "This position is not eligible for work authorization sponsorship by Synthetic Employer.",
        skill,
      ].join("\n"),
    );
    expect(
      result.requirements.filter((item) => item.status === "unknown").map((item) => item.evidence),
    ).toEqual([subjective, skill]);
    expect(
      result.requirements.find((item) => item.requirement === "No sponsorship required")?.status,
    ).toBe("satisfied");
    expect(
      result.requirements.some(
        (item) => item.requirement === "Citizenship requirement needs review",
      ),
    ).toBe(false);
  });

  test("EEO prose without a heading cannot turn citizenship into a restriction or hide a real one", () => {
    const restriction = "Applicants must hold US citizenship.";
    const result = evaluate(
      [
        "Requirements",
        "Strong analytical judgment",
        "All qualified applicants receive consideration without regard to citizenship, age, or disability.",
        restriction,
        "Candidates must have advanced Excel skills.",
      ].join("\n"),
    );
    expect(
      result.requirements.filter(
        (item) => item.requirement === "Citizenship requirement needs review",
      ),
    ).toEqual([expect.objectContaining({ evidence: restriction, status: "unknown" })]);
    expect(result.requirements.some((item) => item.evidence.includes("advanced Excel"))).toBe(true);
  });

  test.each([
    "no travel is required",
    "No prior experience is required",
  ])("%s is optional without discarding adjacent hard requirements", (optional) => {
    const result = evaluate(
      `Requirements\n${optional}; Applicants must hold an active license.\nNo visa sponsorship is available.`,
    );
    expect(result.requirements.some((item) => item.evidence.startsWith(optional))).toBe(false);
    expect(
      result.requirements.find(
        (item) => item.evidence === "Applicants must hold an active license.",
      )?.status,
    ).toBe("unknown");
    expect(
      result.requirements.find((item) => item.requirement === "No sponsorship required")?.status,
    ).toBe("satisfied");
  });

  test("ideal-candidate section preserves unmarked skills and subjective qualifications, with optional experience separate", () => {
    const desire = "Possess strong desire to work in consulting";
    const skill = "Proficiency in PowerPoint and Excel";
    const onsite =
      "Intern will be in the DFW area, with the ability to get to the client site if necessary.";
    const result = evaluate(
      [
        "Our ideal candidate:",
        `${desire} – previous consulting or technology experience ideal, but not required`,
        "Strong analytical judgment",
        skill,
        "We pride ourselves on:",
        "Working closely with our clients",
        "Why Synthetic Employer:",
        "You will develop client relationships; no travel is required",
        "Work Expectations:",
        onsite,
      ].join("\n"),
    );
    expect(
      result.requirements.filter((item) => item.status === "unknown").map((item) => item.evidence),
    ).toEqual([desire, "Strong analytical judgment", skill, onsite]);
    expect(
      result.fitReasons.some((item) =>
        item.includes("previous consulting or technology experience"),
      ),
    ).toBe(true);
  });

  test("summer internship title does not make its separate Class of 2028 cohort month-specific", () => {
    const result = evaluate(
      "Who You Are\nStrong judgment",
      "MBA Summer Internship: Leadership (MBA Class of 2028)",
    );
    expect(
      result.requirements.find((item) => item.requirement === "Graduation cohort"),
    ).toMatchObject({ status: "satisfied", candidateEvidence: "2028" });
    const distinctYear = evaluate("", "Summer 2027 MBA Internship (Class of 2029)");
    expect(
      distinctYear.requirements.find((item) => item.requirement === "Graduation cohort")?.status,
    ).toBe("violated");
  });

  test("explicit graduation months remain unknown even in a seasonal title", () => {
    const result = evaluate(
      "Requirements\nApplicants must graduate in June 2028.",
      "MBA Summer Internship (Class of 2028)",
    );
    expect(
      result.requirements
        .filter((item) => item.requirement === "Graduation cohort")
        .map((item) => item.status),
    ).toEqual(["satisfied", "unknown"]);
    const monthBefore = evaluate(
      "Requirements\nBy June 2028, applicants must graduate in 2028.",
      "MBA Summer Internship (Class of 2028)",
    );
    expect(
      monthBefore.requirements
        .filter((item) => item.requirement === "Graduation cohort")
        .map((item) => item.status),
    ).toEqual(["satisfied", "unknown"]);
  });

  test("genuine required travel and citizenship remain unknown", () => {
    const result = evaluate(
      "Requirements\nTravel is required.\nUS citizenship is required.\nAdvanced SQL knowledge",
    );
    expect(result.requirements.filter((item) => item.status === "unknown")).toHaveLength(3);
  });
});
