import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import {
  type PersonalScreeningAnswer,
  personalScreeningAnswersInputSchema,
} from "@jobpilot/contracts/personal-readiness";
import { validateScreeningAnswerSources } from "./screening-provenance";
import { describe, expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({});
const evidence = {
  id: crypto.randomUUID(),
  sourceHash: "a".repeat(64),
  details: {
    manifest: {
      leaves: [
        { pointer: "/education/0/degree", value: "Master of Business Administration Candidate" },
        { pointer: "/education/0/school", value: "Columbia Business School" },
      ],
    },
  },
};
function input(
  transformation: "mba_degree_without_candidate" | "cbs_parent_university",
  fieldName: string,
  pointer: string,
  value: string,
): PersonalScreeningAnswer {
  return {
    key: fieldName,
    fieldName,
    value,
    source: {
      kind: "resume_normalized",
      evidenceId: evidence.id,
      sourceHash: evidence.sourceHash,
      pointer,
      transformation,
    },
  };
}
const validate = (answer: PersonalScreeningAnswer, current = evidence) =>
  validateScreeningAnswerSources([answer], settings, current, null);
describe("published ATS education labels", () => {
  test("candidate degree supports precisely the plain and published MBA labels without numeric option IDs", () => {
    const base = input(
      "mba_degree_without_candidate",
      "degree",
      "/education/0/degree",
      "Master of Business Administration (M.B.A.)",
    );
    expect(() => validate(base)).not.toThrow();
    expect(() => validate({ ...base, value: "Master of Business Administration" })).not.toThrow();
    for (const value of [
      "7212879",
      "MBA",
      "Master of Business Administration (MBA)",
      "Bachelor of Business Administration (B.B.A.)",
      "Master of Business Administration (M.B.A.) completed",
    ])
      expect(() => validate({ ...base, value })).toThrow("transformation");
  });
  test("only the exact current CBS school fact can map to its parent university", () => {
    const base = input(
      "cbs_parent_university",
      "school_name",
      "/education/0/school",
      "Columbia University",
    );
    expect(
      personalScreeningAnswersInputSchema.safeParse({
        expectedUpdatedAt: new Date().toISOString(),
        answers: [base],
      }).success,
    ).toBe(true);
    expect(() => validate(base)).not.toThrow();
    for (const value of [
      "Columbia College",
      "Columbia Business School Executive Education",
      "NYU Stern School of Business",
      "Harvard Business School",
      "Columbia University",
    ])
      expect(() =>
        validate(base, {
          ...evidence,
          details: { manifest: { leaves: [{ pointer: "/education/0/school", value }] } },
        }),
      ).toThrow("transformation");
    for (const value of [
      "7212879",
      "Harvard University",
      "Columbia University Graduate",
      "Columbia",
    ])
      expect(() => validate({ ...base, value })).toThrow("transformation");
    for (const fieldName of ["degree", "citizenship", "work_authorization", "demographic_123"])
      expect(() => validate({ ...base, fieldName })).toThrow("transformation");
    const resolved = {
      ...evidence,
      details: {
        ...evidence.details,
        resolution: { document: { education: [{ school: "Columbia Business School" }] } },
      },
    };
    const source = base.source as Extract<
      PersonalScreeningAnswer["source"],
      { kind: "resume_normalized" }
    >;
    expect(() =>
      validate(
        { ...base, source: { ...source, pointer: "/resolved/education/0/school" } },
        resolved,
      ),
    ).not.toThrow();
    expect(() => validate(base, { ...evidence, id: crypto.randomUUID() })).toThrow("superseded");
  });
});
