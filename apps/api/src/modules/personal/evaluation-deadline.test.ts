import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { assessPostingDeadlines } from "./deadline-policy";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

const notice =
  "This role will remain open until November 6, 2026 and we will review all applications at that time.";

function evaluate(clause: string, now = "2026-10-01T12:00:00Z", deadline: string | null = null) {
  return evaluatePosting(
    {
      title: "MBA summer internship",
      employer: "Synthetic Employer",
      descriptionText: `Work Expectations\nApplicants must be enrolled in an MBA program.\n${clause}`,
      location: "New York, NY",
      deadline,
    },
    { mbaEnrolled: true, mbaGraduationYear: 2028 },
    { now: new Date(now) },
    EMPTY_RESUME_DATA,
  );
}

describe("source-grounded administrative closing notices", () => {
  test("future closing date is an employer constraint with its complete source quote", () => {
    const result = evaluate(notice);
    expect(result.eligibility).toBe("eligible");
    expect(result.requirements).toEqual([
      expect.objectContaining({ requirement: "MBA enrollment", status: "satisfied" }),
      expect.objectContaining({
        requirement: "Application deadline",
        evidence: notice,
        status: "satisfied",
        candidateEvidence: expect.stringContaining("closing time and timezone are unspecified"),
      }),
    ]);
  });

  test("passed closing date is ineligible even when no structured deadline is present", () => {
    const result = evaluate(notice, "2026-11-08T00:00:00Z");
    expect(result.eligibility).toBe("ineligible");
    expect(result.requirements).toContainEqual(
      expect.objectContaining({
        requirement: "Application deadline",
        evidence: notice,
        status: "violated",
      }),
    );
    expect(result.blockers).toContain("Application deadline has passed");
  });

  test.each([
    "November 2026",
    "11/06",
    "11/06/2026",
    "February 30, 2026",
    "November 0, 2026",
    "Notamonth 6, 2026",
  ])("incomplete, ambiguous or invalid %s is a source timing hold", (date) => {
    const source = `This role will remain open until ${date} and we will review all applications at that time.`;
    const result = evaluate(source);
    expect(result.eligibility).toBe("unknown");
    expect(
      result.requirements
        .filter((item) => item.evidence === source)
        .every((item) => item.status !== "satisfied"),
    ).toBe(true);
    expect(result.requirements).toEqual([
      expect.objectContaining({ requirement: "MBA enrollment", status: "satisfied" }),
      expect.objectContaining({
        requirement: "Application deadline",
        status: "unknown",
        evidence: source,
        candidateEvidence: expect.stringContaining("verify the source, not a personal answer"),
      }),
    ]);
  });

  test.each([
    "This role will remain open until.",
    "This role will remain open until ???",
  ])("malformed notice %s never becomes eligible by omission", (source) => {
    const result = evaluate(source);
    expect(result.eligibility).toBe("unknown");
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ requirement: "Application deadline", status: "unknown" }),
    );
  });

  test.each(["\n", " "])("adjacent graduation condition survives delimiter %j", (separator) => {
    const condition = "Candidates must have completed an MBA by June 2027.";
    const result = evaluate(`${notice}${separator}${condition}`);
    expect(result.eligibility).toBe("unknown");
    expect(result.requirements).toContainEqual(
      expect.objectContaining({
        requirement: "Graduation cohort",
        evidence: condition,
        status: "unknown",
      }),
    );
    expect(
      result.requirements.filter((item) => item.requirement === "Application deadline"),
    ).toEqual([expect.objectContaining({ evidence: notice, status: "satisfied" })]);
  });

  test.each([
    "This role will remain open until November 6, 2026 and applicants must possess an active professional license.",
    "This role will remain open until November 6, 2026 and must possess an active professional license.",
  ])("appended mandatory conditions in %s are not swallowed", (source) => {
    const result = evaluate(source);
    expect(result.eligibility).toBe("unknown");
    expect(
      result.requirements
        .filter((item) => item.evidence === source)
        .every((item) => item.status !== "satisfied"),
    ).toBe(true);
    expect(result.requirements).toContainEqual(
      expect.objectContaining({
        requirement: "Other stated requirement needs review",
        status: "unknown",
        evidence: expect.stringContaining("active professional license"),
      }),
    );
  });

  test.each([
    ["2026-10-01T12:00:00Z", "2026-09-30T12:00:00Z"],
    ["2026-11-08T00:00:00Z", "2026-12-01T12:00:00Z"],
  ])("structured and textual constraints both apply at %s", (now, structured) => {
    const result = evaluate(notice, now, structured);
    const deadlines = result.requirements.filter(
      (item) => item.requirement === "Application deadline",
    );
    expect(deadlines).toHaveLength(2);
    expect(deadlines.some((item) => item.status === "violated")).toBe(true);
    expect(result.eligibility).toBe("ineligible");
  });

  test("the timezone uncertainty window is bounded, without inventing a closing instant", () => {
    const start = Date.parse("2026-11-05T10:00:00Z");
    const end = Date.parse("2026-11-07T12:00:00Z");
    const posting = { descriptionText: notice, deadline: null };
    for (const [now, status] of [
      [start - 1, "satisfied"],
      [start, "unknown"],
      [end - 1, "unknown"],
      [end, "violated"],
    ] as const) {
      expect(assessPostingDeadlines(posting, now)).toEqual([
        expect.objectContaining({ status, precision: "date_only", calendarDate: "2026-11-06" }),
      ]);
    }
    expect(evaluate(notice, new Date(start).toISOString()).eligibility).toBe("unknown");
  });

  test("explicitly offset timestamps retain their precise boundary", () => {
    const deadline = "2026-11-06T12:00:00-05:00";
    const now = Date.parse(deadline);
    const posting = { descriptionText: "", deadline };
    expect(assessPostingDeadlines(posting, now)[0]).toMatchObject({
      precision: "instant",
      status: "satisfied",
    });
    expect(assessPostingDeadlines(posting, now + 1)[0]).toMatchObject({
      precision: "instant",
      status: "violated",
    });
  });

  test("structured date-only and invalid timestamp fields remain conservative", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    for (const deadline of ["2026-11-06", "2026-11-06T12:00:00", "2026-02-30T12:00:00Z"])
      expect(assessPostingDeadlines({ descriptionText: "", deadline }, now)[0].status).toBe(
        "unknown",
      );
  });

  test("ambiguous trailing timing is unknown even outside a qualification section", () => {
    const source = "This role will remain open until November 6, 2026 or December 1, 2026.";
    expect(
      assessPostingDeadlines(
        { descriptionText: source, deadline: null },
        Date.parse("2026-10-01T12:00:00Z"),
      ),
    ).toEqual([
      expect.objectContaining({ sourceQuote: source, status: "unknown", precision: "unknown" }),
    ]);
  });
});
