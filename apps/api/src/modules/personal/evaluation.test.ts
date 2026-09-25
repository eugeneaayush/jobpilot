import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

const posting = (descriptionText: string, title = "Analyst") => ({
  title,
  descriptionText,
  employer: "Example",
  location: "New York",
  deadline: null,
});
describe("eligibility independent of fit", () => {
  test("cohort violation blocks MBA role even with skill overlap", () => {
    const result = evaluatePosting(
      posting(
        "MBA candidates must graduate in 2027. Finance expertise preferred",
        "MBA Summer Associate",
      ),
      { mbaGraduationYear: 2028 },
      { keywords: ["finance"] },
      { ...EMPTY_RESUME_DATA, basics: { name: "Test" }, summary: "Finance" },
    );
    expect(result.track).toBe("mba_internship");
    expect(result.eligibility).toBe("ineligible");
    expect(result.fitScore).toBeGreaterThan(40);
    expect(result.requirements[0]?.evidence).toContain("2027");
  });
  test("ordinary MBA preferences or experienced-role requirements stay general professional", () => {
    for (const [title, description] of [
      [
        "Corporate Development Integration Lead",
        "MBA preferred. Must have 8 years of professional experience.",
      ],
      [
        "Corporate Development Director",
        "An MBA is required. Must have 10 years of relevant experience.",
      ],
      ["Strategy Manager", "Full-time position. MBA preferred."],
      ["Strategy Director", "Must have an MBA and 5 years of post-MBA experience."],
      [
        "Program Manager",
        "MBA preferred. Lead a full-time rotational program for new engineering graduates.",
      ],
      ["Leadership Development Manager", "MBA preferred. Manage executive training."],
    ]) {
      expect(evaluatePosting(posting(description!, title!), {}, {}, EMPTY_RESUME_DATA).track).toBe(
        "general_professional",
      );
    }
  });
  test("explicit post-MBA and MBA graduate-entry program signals select post-MBA full-time", () => {
    for (const [title, description] of [
      ["Post-MBA Strategy Associate", "MBA required."],
      ["MBA Full-Time Associate", "Applications for the upcoming recruiting year."],
      ["MBA Leadership Development Program", "MBA candidates welcome."],
      ["Leadership Development Program", "MBA required."],
      [
        "Strategy Associate",
        "Our full-time entry program recruits MBA candidates graduating in 2028.",
      ],
      ["Finance Associate", "This rotational program is for recent MBA graduates."],
    ]) {
      expect(evaluatePosting(posting(description!, title!), {}, {}, EMPTY_RESUME_DATA).track).toBe(
        "post_mba_fulltime",
      );
    }
  });
  test("MBA internships retain priority over post-MBA program language", () => {
    const result = evaluatePosting(
      posting(
        "MBA candidates join our internship before the full-time program for recent MBA graduates.",
        "MBA Leadership Development Program Intern",
      ),
      {},
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.track).toBe("mba_internship");
    expect(
      evaluatePosting(
        posting("MBA preferred.", "Finance Summer Associate"),
        {},
        {},
        EMPTY_RESUME_DATA,
      ).track,
    ).toBe("mba_internship");
  });
  test("general jobs retained with unknown work authorization", () => {
    const result = evaluatePosting(
      posting("Must be authorized to work in the US."),
      {},
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.track).toBe("general_professional");
    expect(result.eligibility).toBe("unknown");
  });
  test("citizenship does not infer work authorization or automatically disqualify", () => {
    const result = evaluatePosting(
      posting("US citizenship is required."),
      { citizenship: "US" },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(result.blockers).toEqual([]);
  });
  test("expired and restricted roles block", () => {
    const result = evaluatePosting(
      { ...posting("Finance"), deadline: "2025-01-01T00:00:00Z" },
      {},
      { now: new Date("2026-01-01"), restrictedEmployers: ["Example"] },
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("ineligible");
    expect(result.blockers).toContain("Restricted employer");
  });
  test("preferred experience is never mandatory", () => {
    const result = evaluatePosting(
      posting("10 years experience preferred."),
      { yearsExperience: 2 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(result.blockers).toEqual([]);
  });
  test("supplied authorization can satisfy a clear requirement", () => {
    const result = evaluatePosting(
      posting("Must be authorized to work in the US."),
      { workAuthorized: true, workAuthorizationCountries: ["US"] },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("eligible");
  });
  test("explicit candidate date ranges can satisfy or violate explicit posting dates", () => {
    const job = posting("Must be available from 2027-06-01 through 2027-08-31.");
    const satisfied = evaluatePosting(
      job,
      { availabilityStart: "2027-05-15", availabilityEnd: "2027-09-01" },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(
      satisfied.requirements.find((entry) => entry.requirement === "Availability date range")
        ?.status,
    ).toBe("satisfied");
    const violated = evaluatePosting(
      job,
      { availabilityStart: "2027-07-01" },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(violated.eligibility).toBe("ineligible");
    expect(evaluatePosting(job, {}, {}, EMPTY_RESUME_DATA).eligibility).toBe("unknown");
  });
  test("availability dates do not infer immediate or full-time availability", () => {
    const result = evaluatePosting(
      posting("Must be available full-time this summer."),
      { availabilityStart: "2027-01-01", availabilityEnd: "2027-12-31" },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.requirements.find((entry) => entry.requirement === "Availability")?.status).toBe(
      "unknown",
    );
  });
  test("non-exact availability notes are preserved as evidence without inventing dates or hours", () => {
    const notes = "Part-time as soon as possible; full-time starting summer 2027";
    const result = evaluatePosting(
      posting("Must be available full-time for the internship.", "MBA Intern"),
      { availabilityNotes: notes },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.requirements.find((entry) => entry.requirement === "Availability")).toMatchObject(
      {
        status: "unknown",
        candidateEvidence: notes,
      },
    );
  });
});

describe("qualification section evidence", () => {
  test("extracts unmarked qualification bullets and leaves subjective skills unknown", () => {
    const description =
      "The candidate will support portfolio reporting.\nQualifications & Desired Skills\nBachelor's degree in finance\n3 years of professional experience\nStrong judgment and attention to detail\nMBA preferred\nResponsibilities\nThe candidate will support investment decisions.\nBenefits\nCompetitive salary";
    const result = evaluatePosting(
      posting(description),
      { yearsExperience: 4 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.requirements.map((item) => item.evidence)).toEqual([
      "Bachelor's degree in finance",
      "3 years of professional experience",
      "Strong judgment and attention to detail",
    ]);
    expect(
      result.requirements.find((item) => item.requirement === "Minimum experience")?.status,
    ).toBe("satisfied");
    expect(
      result.requirements.find((item) => item.evidence.startsWith("Strong judgment"))?.status,
    ).toBe("unknown");
    expect(result.fitReasons.some((reason) => reason.includes("MBA preferred"))).toBe(true);
    expect(result.eligibility).toBe("unknown");
  });
  test("what you bring and who you are headings make exact clauses reviewable", () => {
    for (const heading of [
      "What you bring:",
      "Who you are",
      "What we're looking for",
      "Your qualifications",
    ]) {
      const result = evaluatePosting(
        posting(
          `${heading}\nExperience building financial models\nFluency in SQL\nWhat you'll do\nBuild quarterly reports`,
        ),
        {},
        {},
        EMPTY_RESUME_DATA,
      );
      expect(result.requirements.map((item) => item.evidence)).toEqual([
        "Experience building financial models",
        "Fluency in SQL",
      ]);
      expect(result.requirements.every((item) => item.status === "unknown")).toBe(true);
    }
  });
  test("inline headings and preferred sections remain distinct", () => {
    const result = evaluatePosting(
      posting(
        "Requirements: 5 years experience\nPreferred qualifications\nAn MBA\n10 years experience\nBenefits\nGenerous paid leave",
      ),
      { yearsExperience: 5 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.evidence).toBe("5 years experience");
    expect(result.eligibility).toBe("eligible");
    expect(result.fitReasons.some((reason) => reason.includes("10 years experience"))).toBe(true);
  });
  test("unstructured postings keep exact source text for review rather than a canned requirement", () => {
    const description = "Experience with financial modelling and clear written communication.";
    const result = evaluatePosting(posting(description), {}, {}, EMPTY_RESUME_DATA);
    expect(result.requirements).toEqual([
      {
        requirement: "Posting eligibility source review",
        evidence: description,
        status: "unknown",
        candidateEvidence: null,
      },
    ]);
    expect(result.eligibility).toBe("unknown");
  });
});

describe("qualification boundary and optional-clause handling", () => {
  test("privacy and compensation sections terminate the Garda-style qualification list", () => {
    const description = [
      "Qualifications & Desired Skills",
      "Strong quantitative reasoning",
      "Prior experience in credit markets is not necessary",
      "Candidate Privacy Notice",
      "Within the range, individual pay is determined by work location and additional factors, such as job-related skills, experience, and relevant education.",
      "Hourly Compensation for this role is expected to be between:",
      "$55 &mdash; $55 USD",
    ].join("\n");
    const result = evaluatePosting(posting(description), {}, {}, EMPTY_RESUME_DATA);
    expect(result.requirements.map((item) => item.evidence)).toEqual([
      "Strong quantitative reasoning",
    ]);
    expect(
      result.fitReasons.some((reason) =>
        reason.includes("Prior experience in credit markets is not necessary"),
      ),
    ).toBe(true);
  });
  test("pay prose can end an unclosed section while later explicit eligibility remains visible", () => {
    const quote =
      "Within the range, individual pay is determined by work location and additional factors, such as job-related skills, experience, and relevant education.";
    const result = evaluatePosting(
      posting(
        `Qualifications\nStrong communication\n${quote}\nMust be authorized to work in the US.\nBenefits\nApplicants must have 3 years of professional experience.`,
      ),
      {},
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.requirements.map((item) => item.evidence)).toEqual([
      "Strong communication",
      "Must be authorized to work in the US.",
      "Applicants must have 3 years of professional experience.",
    ]);
  });
  test("not-required experience is optional and never becomes a minimum-years failure", () => {
    const result = evaluatePosting(
      posting(
        "Requirements\n10 years experience is not required; Applicants must be authorized to work in the US.\nPrior experience in credit markets is not necessary\nAn MBA is not required, but applicants must have advanced SQL knowledge.",
      ),
      { yearsExperience: 1 },
      {},
      EMPTY_RESUME_DATA,
    );
    expect(result.eligibility).toBe("unknown");
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements.every((item) => item.status === "unknown")).toBe(true);
    expect(result.requirements.some((item) => item.requirement === "Minimum experience")).toBe(
      false,
    );
    expect(result.requirements[1]?.evidence).toContain("advanced SQL knowledge");
  });
});
