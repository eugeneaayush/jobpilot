import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import {
  type PersonalScreeningAnswer,
  personalScreeningAnswersInputSchema,
} from "@jobpilot/contracts/personal-readiness";
import { manifestHash } from "./persistence-policy";
import {
  validateManifestScreeningSources,
  validateScreeningAnswerSources,
  validateScreeningSnapshot,
} from "./screening-provenance";
import { describe, expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({});
const delegated: PersonalScreeningAnswer = {
  key: "demographic_123",
  fieldName: "demographic_123",
  value: "I don't wish to answer",
  source: { kind: "delegated_preference", preference: "decline_voluntary_demographics" },
};
const validate = (answer: PersonalScreeningAnswer) =>
  validateScreeningAnswerSources([answer], settings, null, null);
describe("delegated voluntary demographic preferences", () => {
  test("records delegation distinctly from user-confirmed facts", () => {
    const input = personalScreeningAnswersInputSchema.parse({
      expectedUpdatedAt: new Date().toISOString(),
      answers: [delegated],
    });
    expect(input.answers[0]!.source).toEqual({
      kind: "delegated_preference",
      preference: "decline_voluntary_demographics",
    });
    expect(input.answers[0]!.source).not.toHaveProperty("confirmed");
    expect(() => validate(input.answers[0]!)).not.toThrow();
    expect(
      personalScreeningAnswersInputSchema.safeParse({
        expectedUpdatedAt: new Date().toISOString(),
        answers: [
          {
            ...delegated,
            source: { kind: "delegated_preference", preference: "infer_demographics" },
          },
        ],
      }).success,
    ).toBe(false);
  });
  test("rejects attributes, opaque option IDs, booleans and strings that only contain a decline phrase", () => {
    for (const value of [
      true,
      false,
      "7045",
      "Male",
      "Female",
      "Asian",
      "Other",
      "Unknown",
      "No",
      "Yes",
      "None",
      "I don't wish to answer because I am a veteran",
      "Asian; I prefer not to answer",
      "I don't wish to answer\nMale",
      " I don't wish to answer",
      "I DON'T WISH TO ANSWER",
      "I don't wish to answer.",
    ])
      expect(() => validate({ ...delegated, value })).toThrow("explicit decline");
  });
  test("never supplies a preference answer for authorization, citizenship, disability claims or malformed fields", () => {
    for (const fieldName of [
      undefined,
      "work_authorization",
      "citizenship",
      "disability",
      "gender",
      "race",
      "demographic_",
      "demographic_0",
      "demographic_123.extra",
      "demographic_123\ncitizenship",
      "demographic_123answer",
      "demographic_-1",
    ])
      expect(() => validate({ ...delegated, fieldName })).toThrow("demographic fields");
    expect(() =>
      validate({ ...delegated, fieldName: undefined, key: "demographic_123" }),
    ).toThrow();
  });
  test("preserves delegated provenance through saved snapshots and immutable manifests", () => {
    const record = {
      id: crypto.randomUUID(),
      identity: "greenhouse:synthetic:123",
      details: { posting: { contentHash: "b".repeat(64) }, screeningAnswers: {} },
    };
    const content = {
      schemaVersion: 1,
      recordId: record.id,
      identity: record.identity,
      postingContentHash: "b".repeat(64),
      settingsHash: manifestHash(settings),
      createdAt: new Date().toISOString(),
      answers: [delegated],
    };
    const snapshot = { ...content, snapshotHash: manifestHash(content) };
    record.details.screeningAnswers = snapshot;
    expect(validateScreeningSnapshot(record, settings, null)?.answers[0]?.source.kind).toBe(
      "delegated_preference",
    );
    const { source: _source, ...value } = delegated;
    const manifest = {
      answers: [value],
      screeningAnswerSnapshot: snapshot,
      screeningAnswerSnapshotHash: snapshot.snapshotHash,
    };
    expect(() => validateManifestScreeningSources(manifest, record, settings, null)).not.toThrow();
    const changed = { ...delegated, value: "Asian" };
    const changedContent = { ...content, answers: [changed] };
    const changedSnapshot = { ...changedContent, snapshotHash: manifestHash(changedContent) };
    record.details.screeningAnswers = changedSnapshot;
    expect(() => validateScreeningSnapshot(record, settings, null)).toThrow("explicit decline");
  });
  test("existing explicit-user and resume/settings source rules retain their meanings", () => {
    const explicit: PersonalScreeningAnswer = {
      ...delegated,
      fieldName: "user_supplied_field",
      value: "User's exact answer",
      source: { kind: "explicit_user", confirmed: true },
    };
    expect(() => validate(explicit)).not.toThrow();
    expect(
      personalScreeningAnswersInputSchema.safeParse({
        expectedUpdatedAt: new Date().toISOString(),
        answers: [{ ...explicit, source: { kind: "explicit_user", confirmed: false } }],
      }).success,
    ).toBe(false);
    const resume: PersonalScreeningAnswer = {
      ...delegated,
      source: {
        kind: "resume",
        evidenceId: crypto.randomUUID(),
        sourceHash: "a".repeat(64),
        pointer: "/facts/value",
      },
    };
    expect(() => validate(resume)).toThrow("superseded");
  });
});
