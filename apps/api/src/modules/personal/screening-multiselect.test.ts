import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { personalScreeningAnswersInputSchema } from "@jobpilot/contracts/personal-readiness";
import { preparedCampaignAnswers } from "./campaign-policy";
import { manifestHash } from "./persistence-policy";
import { answeredScreeningFields } from "./readiness-policy";
import { validateScreeningAnswerSources } from "./screening-provenance";
import { describe, expect, test } from "bun:test";

describe("complete sourced multiselect answers", () => {
  const settings = personalSettingsSchema.parse({ targetFunctions: ["Research", "Trading"] });
  const answer = {
    key: "teams",
    fieldName: "question_42",
    value: ["Research", "Trading"],
    source: {
      kind: "settings" as const,
      pointer: "/targetFunctions",
      settingsHash: manifestHash(settings),
    },
  };
  test("persists the complete exact sourced array through frozen campaign answers", () => {
    const input = personalScreeningAnswersInputSchema.parse({
      expectedUpdatedAt: new Date().toISOString(),
      answers: [answer],
    });
    expect(() => validateScreeningAnswerSources(input.answers, settings, null, null)).not.toThrow();
    expect(preparedCampaignAnswers(input.answers)[0]?.value).toEqual(["Research", "Trading"]);
    for (const value of [["Research"], ["Research", "Invented"]]) {
      expect(() =>
        validateScreeningAnswerSources([{ ...answer, value }], settings, null, null),
      ).toThrow("exactly match");
    }
  });
  test("rejects duplicate, blank, overbound and scalar-substitute arrays", () => {
    for (const value of [
      ["Research", "Research"],
      [" "],
      [true],
      Array.from({ length: 51 }, (_, i) => String(i)),
    ]) {
      expect(
        personalScreeningAnswersInputSchema.safeParse({
          expectedUpdatedAt: new Date().toISOString(),
          answers: [{ ...answer, value }],
        }).success,
      ).toBe(false);
    }
    expect(() =>
      validateScreeningAnswerSources(
        [{ ...answer, source: { ...answer.source, pointer: "/workAuthorization" } }],
        settings,
        null,
        null,
      ),
    ).toThrow("exactly match");
  });
  test("required selections use exact option values and explicit field identity", () => {
    const questions = [
      {
        fieldName: "question_42",
        label: "Teams",
        multiple: true,
        options: [
          { value: "Research", label: "Research team" },
          { value: "Trading", label: "Trading team" },
        ],
      },
      {
        fieldName: "question_43",
        label: "Teams",
        multiple: true,
        options: [{ value: "Other", label: "Other team" }],
      },
    ];
    expect([...answeredScreeningFields([answer], questions)]).toEqual(["question_42"]);
    expect([
      ...answeredScreeningFields([{ ...answer, fieldName: undefined, label: "Teams" }], questions),
    ]).toEqual([]);
    expect(() =>
      answeredScreeningFields([{ ...answer, value: ["Research team"] }], questions),
    ).toThrow("option inventory");
    expect(() => answeredScreeningFields([{ ...answer, value: "Research" }], questions)).toThrow(
      "explicit answer set",
    );
    expect([...answeredScreeningFields([{ ...answer, value: [] }], questions)]).toEqual([]);
  });
});
