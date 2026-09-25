import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

const evaluate = (clause: string, mbaGraduationYear: number | undefined = 2028) =>
  evaluatePosting(
    {
      title: "MBA Intern",
      descriptionText: `Requirements\n${clause}`,
      employer: "Synthetic Employer",
      location: "New York, NY",
      deadline: null,
    },
    { mbaGraduationYear, mbaEnrolled: true },
    {},
    EMPTY_RESUME_DATA,
  );
const cohort = (clause: string, year?: number) =>
  evaluate(clause, year).requirements.find((item) => item.requirement === "Graduation cohort")!;

describe("graduation requirements preserve candidate date precision", () => {
  test("exact month alternatives cannot be satisfied by matching only their year", () => {
    const clause = "Currently pursuing an MBA graduating in December 2027 or June 2028.";
    const result = evaluate(clause);
    expect(result.eligibility).toBe("unknown");
    expect(cohort(clause)).toEqual({
      requirement: "Graduation cohort",
      status: "unknown",
      evidence: clause,
      candidateEvidence: "2028; graduation month and day are unconfirmed",
    });
    expect(result.requirements.find((item) => item.requirement === "MBA enrollment")?.status).toBe(
      "satisfied",
    );
  });
  test("month-qualified deadlines and inclusive windows remain unknown", () => {
    for (const clause of [
      "MBA candidates must graduate by June 2028.",
      "MBA candidates must graduate between December 2027 and June 2028.",
      "MBA candidates must graduate during Dec 2027–Jun 2028.",
      "MBA candidates must graduate in May 2028.",
      "MBA candidates must graduate between 2027-12 and 2028-06.",
      "MBA candidates must graduate by 06/30/2028.",
      "MBA candidates must graduate in spring 2028.",
      "MBA candidates graduating in 2028 must finish by June.",
    ]) {
      expect(cohort(clause).status).toBe("unknown");
      expect(evaluate(clause).eligibility).toBe("unknown");
    }
  });
  test("abbreviated month punctuation still parks the unparsed date requirement", () => {
    const result = evaluate("MBA candidates must graduate during Dec. 2027–Jun. 2028.");
    expect(result.eligibility).toBe("unknown");
    expect(result.requirements.some((item) => item.status === "unknown")).toBe(true);
  });
  test("ordinary year cohorts remain satisfied, including modal may", () => {
    for (const clause of [
      "MBA candidates must graduate in 2028.",
      "MBA Class of 2028.",
      "MBA candidates may graduate in 2028.",
    ]) {
      expect(cohort(clause).status).toBe("satisfied");
      expect(cohort(clause).candidateEvidence).toBe("2028");
    }
  });
  test("unambiguous year-only ranges include interior years", () => {
    for (const clause of [
      "MBA candidates must graduate between 2027 and 2029.",
      "MBA candidates must graduate from 2027 through 2029.",
      "MBA candidates must graduate in 2027–2029.",
    ]) {
      for (const year of [2027, 2028, 2029]) expect(cohort(clause, year).status).toBe("satisfied");
      for (const year of [2026, 2030]) expect(cohort(clause, year).status).toBe("violated");
    }
  });
  test("discrete year alternatives do not become an inclusive window", () => {
    const clause = "MBA candidates must graduate in 2027 or 2029.";
    expect(cohort(clause, 2028).status).toBe("violated");
    expect(cohort(clause, 2027).status).toBe("satisfied");
    expect(cohort(clause, 2029).status).toBe("satisfied");
  });
  test("a reversed year range remains unknown", () => {
    expect(cohort("MBA candidates must graduate between 2029 and 2027.").status).toBe("unknown");
  });
});
