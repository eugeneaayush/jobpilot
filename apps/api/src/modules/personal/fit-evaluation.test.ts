import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { evaluatePosting } from "./evaluation";
import {
  buildFitEvaluation,
  campaignKeywords,
  containsTerm,
  normalizedTerms,
} from "./fit-evaluation";
import { describe, expect, test } from "bun:test";

const posting = {
  title: "MBA internship",
  employer: "Example",
  descriptionText: "Must be enrolled in an MBA. PE, VC, AI, C++ and C# are preferred.",
  location: "New York",
  deadline: null,
};
const resume = { ...EMPTY_RESUME_DATA, basics: { name: "Applicant" }, summary: "PE and AI. C++" };

describe("source-bound fit evidence", () => {
  test("uses the same frozen campaign terms before and after drafting", () => {
    const base = {
      ...resume,
      skills: [{ group: "Technical", items: ["C++", "C#"] }],
      sections: [
        { title: "Additional", entries: [{ heading: "Skills", bullets: ["PE; VC, AI"] }] },
      ],
    };
    const prefs = { keywords: campaignKeywords(base, { targetFunctions: ["PE"] }) };
    const before = buildFitEvaluation(posting, prefs, base);
    const after = buildFitEvaluation(posting, prefs, base, { ...base, skills: [], sections: [] });
    expect(prefs.keywords).toEqual(["PE", "C++", "C#", "VC", "AI"]);
    expect(after.campaignInputsHash).toBe(before.campaignInputsHash);
    expect(after.postingTerms).toEqual(before.postingTerms);
    expect(after.supportedButOmitted).toEqual(["c#", "vc"]);
  });
  test("matches short terms and punctuation without substring matches", () => {
    for (const term of ["PE", "VC", "AI", "C++", "C#"])
      expect(containsTerm(`Skills: ${term}; research`, term)).toBe(true);
    for (const [text, term] of [
      ["experience", "pe"],
      ["paid", "ai"],
      ["C++", "C"],
      ["C#", "C"],
      ["C++++", "C++"],
    ])
      expect(containsTerm(text!, term!)).toBe(false);
    expect(containsTerm("financial-modeling", "financial modeling")).toBe(true);
    expect(normalizedTerms([" AI ", "ai", "C++", "C#"])).toEqual(["ai", "c++", "c#"]);
  });

  test("does not count schema keys, IDs or links as resume evidence", () => {
    const evaluation = buildFitEvaluation(
      posting,
      { keywords: ["skills", "education", "VC"] },
      {
        ...EMPTY_RESUME_DATA,
        basics: { name: "Applicant", website: "https://vc.example.com" },
        experience: [
          { id: "VC", company: "Company", title: "Associate", start: "2024", bullets: [] },
        ],
      },
    );
    expect(evaluation.supportedByBase).toEqual([]);
    expect(evaluation.absentFromBase).toEqual(["vc"]);
  });

  test("separates base support, draft omissions and unavailable evidence", () => {
    const draft = { ...resume, summary: "PE" };
    const result = buildFitEvaluation(
      posting,
      { keywords: ["PE", "VC", "AI", "C++", "C#"] },
      resume,
      draft,
    );
    expect(result.supportedInDraft).toEqual(["pe"]);
    expect(result.supportedButOmitted).toEqual(["ai", "c++"]);
    expect(result.absentFromBase).toEqual(["vc", "c#"]);
    expect(result).toEqual(
      buildFitEvaluation(posting, { keywords: ["PE", "VC", "AI", "C++", "C#"] }, resume, draft),
    );
    expect(buildFitEvaluation(posting, {}, resume).insufficientEvidence).toContain(
      "no_campaign_terms",
    );
    expect(buildFitEvaluation(posting, {}, resume).insufficientEvidence).toContain(
      "draft_not_provided",
    );
    expect(result.resumeHash).not.toBe(result.draftHash);
    expect(result.campaignInputsHash).not.toBe(
      buildFitEvaluation(posting, { keywords: ["PE"] }, resume).campaignInputsHash,
    );
  });

  test("fit cannot override eligibility and low fit remains eligible", () => {
    const low = evaluatePosting(posting, { mbaEnrolled: true }, { keywords: ["VC"] }, resume);
    expect(low.eligibility).toBe("eligible");
    expect(low.fitScore).toBe(45);
    const high = evaluatePosting(posting, { mbaEnrolled: false }, { keywords: ["PE"] }, resume);
    expect(high.fitScore).toBe(85);
    expect(high.eligibility).toBe("ineligible");
    expect(high.fitEvaluation.supportedByBase).toEqual(["pe"]);
  });
});
