import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import { describe, expect, test } from "bun:test";

function evaluate(descriptionText: string) {
  return evaluatePosting(
    {
      title: "Summer 2027 MBA Intern",
      employer: "Synthetic Mobility",
      descriptionText,
      location: "San Francisco, CA",
      deadline: null,
    },
    { mbaEnrolled: true, yearsExperience: 4 },
    {},
    EMPTY_RESUME_DATA,
  );
}

const benefits =
  "Interns are also eligible to participate in the Company’s generous benefits programs, subject to eligibility requirements.";

describe("You have minimums and We prefer preferences", () => {
  test("captures MBA enrollment, domain experience and technical minimums without inferring skills", () => {
    const minimums = [
      "Currently pursuing an MBA.",
      "3–5 years of finance experience.",
      "Salesforce Design and Program Management experience.",
    ];
    const result = evaluate(["You have:", ...minimums, "We prefer:", "SQL expertise."].join("\n"));
    expect(result.requirements).toEqual([
      expect.objectContaining({
        requirement: "MBA enrollment",
        status: "satisfied",
        evidence: minimums[0],
      }),
      expect.objectContaining({ status: "unknown", evidence: minimums[1] }),
      expect.objectContaining({ status: "unknown", evidence: minimums[2] }),
    ]);
    expect(result.eligibility).toBe("unknown");
    expect(result.fitReasons).toContain(
      "Preferred qualification (not a required eligibility condition): SQL expertise.",
    );
  });

  test.each([
    "You have:",
    "YOU HAVE",
    "You have：",
    "You have: Currently pursuing an MBA.",
    "You have：Currently pursuing an MBA.",
  ])("recognizes standalone and inline heading %s", (heading) => {
    const inline = heading.includes("Currently");
    const result = evaluate(
      [
        heading,
        ...(inline ? [] : ["Currently pursuing an MBA."]),
        "3 years of professional experience.",
        "We prefer: 10 years of professional experience.",
      ].join("\n"),
    );
    expect(result.requirements).toEqual([
      expect.objectContaining({ requirement: "MBA enrollment", status: "satisfied" }),
      expect.objectContaining({ requirement: "Minimum experience", status: "satisfied" }),
    ]);
    expect(result.eligibility).toBe("eligible");
    expect(result.fitReasons.some((reason) => reason.includes("10 years"))).toBe(true);
  });

  test("an MBA flag does not establish the required program focus or finance-domain experience", () => {
    const focus =
      "Currently enrolled in an MBA program focused on finance, strategic management and/or technology.";
    const domain = "3-5 years of finance experience.";
    const result = evaluate(
      ["You have:", focus, domain, "We prefer:", "Previous mobility-sector experience."].join("\n"),
    );
    expect(result.requirements).toEqual([
      expect.objectContaining({
        requirement: "MBA enrollment",
        evidence: focus,
        status: "satisfied",
      }),
      expect.objectContaining({
        requirement: "MBA study focus needs review",
        evidence: focus,
        status: "unknown",
      }),
      expect.objectContaining({ evidence: domain, status: "unknown" }),
    ]);
    expect(result.eligibility).toBe("unknown");
    expect(result.requirements.some((item) => item.evidence.includes("mobility-sector"))).toBe(
      false,
    );
  });

  test("You will ends minimums while explicit restrictions still survive in responsibility prose", () => {
    const required = "Applicants must be authorized to work in the United States.";
    const result = evaluate(
      [
        "You have:",
        "Currently pursuing an MBA.",
        "You will:",
        "Design Salesforce solutions and manage programs.",
        required,
      ].join("\n"),
    );
    expect(result.requirements).toEqual([
      expect.objectContaining({ requirement: "MBA enrollment", status: "satisfied" }),
      expect.objectContaining({
        requirement: "Work authorization",
        evidence: required,
        status: "unknown",
      }),
    ]);
  });

  test("benefits participation language is not personal eligibility, and closes the minimums section", () => {
    const result = evaluate(
      [
        "You have:",
        "Currently pursuing an MBA.",
        benefits,
        "Our company offers mentoring and development.",
      ].join("\n"),
    );
    expect(result.requirements).toEqual([
      expect.objectContaining({ requirement: "MBA enrollment", status: "satisfied" }),
    ]);
    expect(result.eligibility).toBe("eligible");
  });

  test.each([
    "\n",
    " ",
  ])("preserves neighboring genuine mandatory restrictions separated by %j", (separator) => {
    const required = "Applicants must hold an active professional license.";
    const authorization = "Applicants must be eligible to work in the United States.";
    const result = evaluate(
      [
        "You have:",
        "Currently pursuing an MBA.",
        [benefits, required, authorization].join(separator),
      ].join("\n"),
    );
    expect(result.requirements.some((item) => item.evidence === benefits)).toBe(false);
    for (const evidence of [required, authorization])
      expect(result.requirements).toContainEqual(
        expect.objectContaining({ evidence, status: "unknown" }),
      );
  });

  test("does not discard benefit-related professional requirements or mixed benefit restrictions", () => {
    const experience = "Benefits program design experience.";
    const mixed =
      "Interns are eligible to participate in benefits programs only if they hold an active professional license.";
    const result = evaluate(
      [
        "You have:",
        "Currently pursuing an MBA.",
        experience,
        mixed,
        "We prefer:",
        "Candidates must hold a valid driver's license.",
      ].join("\n"),
    );
    for (const evidence of [experience, mixed, "Candidates must hold a valid driver's license."])
      expect(result.requirements).toContainEqual(
        expect.objectContaining({ evidence, status: "unknown" }),
      );
  });

  test.each([
    [
      "Applicants are required to be authorized to work in the United States.",
      "Work authorization",
    ],
    ["We cannot sponsor visas for this role.", "No sponsorship required"],
    [
      "We require applicants to hold an active professional license.",
      "Other stated requirement needs review",
    ],
  ])("explicit hard clause survives a preference section: %s", (clause, requirement) => {
    const result = evaluate(
      [
        "You have:",
        "Currently enrolled in an MBA program.",
        "We prefer:",
        "SQL expertise.",
        clause,
      ].join("\n"),
    );
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ evidence: clause, requirement, status: "unknown" }),
    );
    expect(result.eligibility).toBe("unknown");
    expect(result.fitReasons).toContain(
      "Preferred qualification (not a required eligibility condition): SQL expertise.",
    );
    expect(result.fitReasons.some((reason) => reason.includes(clause))).toBe(false);
  });

  test("an explicitly required experience minimum remains hard after We prefer", () => {
    const result = evaluate(
      "You have:\nCurrently pursuing an MBA.\nWe prefer:\n10 years of professional experience is required.",
    );
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ requirement: "Minimum experience", status: "violated" }),
    );
    expect(result.eligibility).toBe("ineligible");
  });

  test("a required subject inside a preferred skill and explicitly optional qualifications stay soft", () => {
    const preferred = [
      "Familiarity with required regulatory reports.",
      "SQL expertise is preferred but not required.",
      "US work authorization preferred.",
      "Candidates without sponsorship preferred.",
    ];
    const result = evaluate(
      ["You have:", "Currently pursuing an MBA.", "We prefer:", ...preferred].join("\n"),
    );
    expect(result.requirements).toHaveLength(1);
    expect(result.eligibility).toBe("eligible");
    for (const clause of preferred)
      expect(result.fitReasons).toContain(
        `Preferred qualification (not a required eligibility condition): ${clause}`,
      );
  });

  test("employer refusal of sponsorship remains binding alongside a preference in the same clause", () => {
    const refusal = "We cannot sponsor visas for this role, although SQL expertise is preferred.";
    const result = evaluate(
      ["You have:", "Currently pursuing an MBA.", "We prefer:", refusal].join("\n"),
    );
    expect(result.requirements).toContainEqual(
      expect.objectContaining({
        requirement: "No sponsorship required",
        evidence: refusal,
        status: "unknown",
      }),
    );
    expect(result.eligibility).toBe("unknown");
  });

  test("optional expertise cannot erase a sponsorship restriction in the same unsplit clause", () => {
    const mixed = "SQL expertise is not required, although we cannot sponsor visas for this role.";
    const result = evaluate(
      ["You have:", "Currently pursuing an MBA.", "We prefer:", mixed].join("\n"),
    );
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ evidence: mixed, status: "unknown" }),
    );
    expect(result.eligibility).toBe("unknown");
  });
});
