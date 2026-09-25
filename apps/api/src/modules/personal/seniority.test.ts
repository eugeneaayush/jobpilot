import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

const posting = (title: string, descriptionText: string) => ({
  title,
  descriptionText,
  employer: "Synthetic employer",
  location: "New York",
  deadline: null,
});

describe("source-supported recruiting seniority", () => {
  test.each([
    [
      "MBA Summer Associate",
      "Candidates must be enrolled in an MBA program.",
      "graduate_recruiting",
    ],
    [
      "Post-MBA Strategy Associate",
      "Entry-level full-time program for recent MBA graduates.",
      "graduate_recruiting",
    ],
    [
      "Research Intern",
      "This internship is for current master's or PhD students.",
      "graduate_recruiting",
    ],
    [
      "Investment Associate",
      "Bachelor's degree required. Must have 3 years of professional experience.",
      "experienced_professional",
    ],
    [
      "Product Manager",
      "Bachelor's degree required. You will own the product roadmap and lead cross-functional teams.",
      "experienced_professional",
    ],
    [
      "Strategy Director",
      "MBA preferred. You will lead the corporate strategy team.",
      "experienced_professional",
    ],
    [
      "Business Analyst Intern",
      "Candidates must be undergraduate students graduating in 2028.",
      "undergraduate_entry",
    ],
    [
      "Entry-Level Analyst",
      "Bachelor's degree required. No prior experience required.",
      "undergraduate_entry",
    ],
    ["Investment Intern", "Open to undergraduate and graduate students.", "unresolved"],
    [
      "MBA Intern",
      "Open to undergraduate and graduate students with the same duties.",
      "unresolved",
    ],
    [
      "Investment Intern",
      "Open to undergraduate and graduate students. The graduate track requires prior professional investment experience and independent investment recommendations.",
      "graduate_recruiting",
    ],
    [
      "Product Management Intern",
      "Bachelor's or master's students welcome. MBA preferred.",
      "unresolved",
    ],
    [
      "Investment Intern",
      "Undergraduate students only. An MBA is not required.",
      "undergraduate_entry",
    ],
    ["Analyst", "Bachelor's degree required. Support the team with research.", "unresolved"],
    ["Senior Product Manager", "", "unresolved"],
    [
      "Product Management Intern",
      "We offer excellent training and our CEO has an MBA.",
      "unresolved",
    ],
    ["Graduate Analyst", "Join our graduate program.", "unresolved"],
    ["Investment Analyst", "Qualifications: 0-2 years of professional experience.", "unresolved"],
    [
      "Investment Intern",
      "Must be an undergraduate student. MBA applicants are not eligible.",
      "undergraduate_entry",
    ],
    [
      "Strategy Associate",
      "Our full-time entry-level program recruits Master of Business Administration candidates graduating in 2028.",
      "graduate_recruiting",
    ],
    [
      "Investment Intern",
      "Open to undergraduate and graduate students. A separate MBA track is reserved for current MBA students.",
      "graduate_recruiting",
    ],
    [
      "Product Manager",
      "Requirements\nBachelor's degree\nResponsibilities\nOwn the product roadmap and lead the product team.",
      "experienced_professional",
    ],
    [
      "Investment Associate",
      "Must have prior professional investment experience.",
      "experienced_professional",
    ],
    ["MBA Intern", "Applicants must be pursuing a bachelor's degree.", "undergraduate_entry"],
    [
      "Investment Intern",
      "Undergraduate or graduate students welcome. Graduate interns do not lead investment decisions.",
      "unresolved",
    ],
  ] as const)("classifies %s from affirmative posting evidence", (title, descriptionText, expected) => {
    const source = posting(title!, descriptionText!);
    const result = evaluatePosting(source, {}, {}, EMPTY_RESUME_DATA).seniority;
    expect(result?.classification).toBe(expected);
    expect(result.reasons.length).toBeGreaterThan(0);
    if (result.classification !== "unresolved") expect(result.evidence.length).toBeGreaterThan(0);
    for (const evidence of result.evidence) {
      const text = evidence.field === "title" ? source.title : source.descriptionText;
      expect(text.includes(evidence.quote)).toBe(true);
      expect(evidence.quote.length).toBeGreaterThan(0);
    }
  });
});

describe("independent mandatory eligibility clauses", () => {
  test("an MBA graduation year cannot satisfy undergraduate enrollment", () => {
    const result = evaluatePosting(
      posting(
        "Business Analyst Intern",
        "Candidates must be undergraduate students graduating in 2028.",
      ),
      { mbaGraduationYear: 2028, mbaEnrolled: true },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).not.toBe("eligible");
    expect(
      result.requirements.some(
        (item) => item.requirement === "Undergraduate enrollment" && item.status === "unknown",
      ),
    ).toBe(true);
    expect(
      result.requirements.find((item) => item.requirement === "Graduation cohort")?.status,
    ).toBe("unknown");
  });

  test("a satisfied experience clause cannot erase a required skill", () => {
    const result = evaluatePosting(
      posting(
        "Investment Associate",
        "Applicants must have 3 years of professional experience and be fluent in Spanish.",
      ),
      { yearsExperience: 5 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(
      result.requirements.some(
        (item) => item.requirement === "Minimum experience" && item.status === "satisfied",
      ),
    ).toBe(true);
    expect(
      result.requirements.some(
        (item) => item.evidence === "be fluent in Spanish." && item.status === "unknown",
      ),
    ).toBe(true);
  });

  test("a satisfied experience clause cannot erase a degree in the same requirement", () => {
    const result = evaluatePosting(
      posting(
        "Investment Associate",
        "Requirements: A bachelor's degree and 3 years of professional experience.",
      ),
      { yearsExperience: 5 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(
      result.requirements.some(
        (item) => item.evidence === "A bachelor's degree" && item.status === "unknown",
      ),
    ).toBe(true);
    expect(
      result.requirements.some(
        (item) => item.requirement === "Minimum experience" && item.status === "satisfied",
      ),
    ).toBe(true);
  });

  test("undergraduates cannot satisfy their cohort with an MBA graduation year", () => {
    const result = evaluatePosting(
      posting("Business Analyst Intern", "Undergraduates must graduate in 2028."),
      { mbaGraduationYear: 2028, mbaEnrolled: true },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(
      result.requirements.find((item) => item.requirement === "Graduation cohort")?.status,
    ).toBe("unknown");
  });

  test("a cohort clause cannot erase an independent technical requirement", () => {
    const result = evaluatePosting(
      posting("MBA Intern", "MBA candidates must graduate in 2028 and know Python."),
      { mbaGraduationYear: 2028 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(
      result.requirements.some(
        (item) => item.evidence === "know Python." && item.status === "unknown",
      ),
    ).toBe(true);
  });
});
