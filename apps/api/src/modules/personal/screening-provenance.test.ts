import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import type { PersonalScreeningAnswer } from "@jobpilot/contracts/personal-readiness";
import { manifestHash } from "./persistence-policy";
import {
  validateManifestScreeningSources,
  validateScreeningAnswerSources,
  validateScreeningSnapshot,
} from "./screening-provenance";
import { describe, expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({
  workAuthorization: true,
  workAuthorizationCountries: ["US"],
});
const evidence = {
  id: crypto.randomUUID(),
  sourceHash: "a".repeat(64),
  details: { manifest: { leaves: [{ pointer: "/experience/0/position", value: "Analyst" }] } },
};
const answer: PersonalScreeningAnswer = {
  key: "position",
  fieldName: "position",
  value: "Analyst",
  source: {
    kind: "resume",
    evidenceId: evidence.id,
    sourceHash: evidence.sourceHash,
    pointer: "/experience/0/position",
  },
};
function fixture(answers: PersonalScreeningAnswer[] = [answer]) {
  const record = {
    id: crypto.randomUUID(),
    identity: "greenhouse:synthetic:123",
    details: {
      posting: { contentHash: "b".repeat(64), location: "New York, US" },
      screeningAnswers: {},
    },
  };
  const content = {
    schemaVersion: 1,
    recordId: record.id,
    identity: record.identity,
    postingContentHash: "b".repeat(64),
    settingsHash: manifestHash(settings),
    createdAt: new Date().toISOString(),
    answers,
  };
  const snapshot = { ...content, snapshotHash: manifestHash(content) };
  record.details.screeningAnswers = snapshot;
  return {
    record,
    snapshot,
    manifest: {
      answers: answers.map(({ source: _source, ...value }) => value),
      screeningAnswerSnapshot: snapshot,
      screeningAnswerSnapshotHash: snapshot.snapshotHash,
    },
  };
}
describe("current screening answer provenance", () => {
  test("accepts the exact current source leaf at save, preview and frozen-manifest gates", () => {
    const f = fixture();
    expect(() => validateScreeningAnswerSources([answer], settings, evidence, "US")).not.toThrow();
    expect(validateScreeningSnapshot(f.record, settings, evidence)?.answers).toEqual([answer]);
    expect(() =>
      validateManifestScreeningSources(f.manifest, f.record, settings, evidence),
    ).not.toThrow();
  });
  test("rejects a superseded evidence ID even with unchanged source hash and settings", () => {
    const f = fixture();
    const current = { ...evidence, id: crypto.randomUUID() };
    expect(() => validateScreeningAnswerSources([answer], settings, current, "US")).toThrow(
      "superseded",
    );
    expect(() => validateScreeningSnapshot(f.record, settings, current)).toThrow("superseded");
    expect(() => validateManifestScreeningSources(f.manifest, f.record, settings, current)).toThrow(
      "superseded",
    );
  });
  test("rejects changed or ambiguous leaves without inferring replacement values", () => {
    const f = fixture();
    const changed = {
      ...evidence,
      details: {
        manifest: { leaves: [{ pointer: "/experience/0/position", value: "Associate" }] },
      },
    };
    expect(() => validateManifestScreeningSources(f.manifest, f.record, settings, changed)).toThrow(
      "exactly match",
    );
    expect(() =>
      validateScreeningAnswerSources(
        [answer],
        settings,
        {
          ...evidence,
          details: {
            manifest: {
              leaves: [...evidence.details.manifest.leaves, ...evidence.details.manifest.leaves],
            },
          },
        },
        "US",
      ),
    ).toThrow("one current");
    expect(() =>
      validateScreeningAnswerSources(
        [answer],
        settings,
        { ...evidence, sourceHash: "c".repeat(64) },
        "US",
      ),
    ).toThrow("superseded");
  });
  test("revalidates current settings values and jurisdiction without boolean coercion", () => {
    const authorization: PersonalScreeningAnswer = {
      key: "work",
      value: true,
      source: {
        kind: "settings",
        settingsHash: manifestHash(settings),
        pointer: "/workAuthorization",
      },
    };
    expect(() =>
      validateScreeningAnswerSources([authorization], settings, evidence, "New York, US"),
    ).not.toThrow();
    expect(() =>
      validateScreeningAnswerSources([authorization], settings, evidence, "London, UK"),
    ).toThrow("jurisdiction");
    expect(() =>
      validateScreeningAnswerSources(
        [{ ...authorization, value: false }],
        settings,
        evidence,
        "New York, US",
      ),
    ).toThrow("exactly match");
    expect(() =>
      validateScreeningAnswerSources(
        [authorization],
        { ...settings, workAuthorization: false },
        evidence,
        "New York, US",
      ),
    ).toThrow("settings changed");
  });
  test("preserves explicit owner assertions without deriving them from new resume content", () => {
    const explicit: PersonalScreeningAnswer = {
      key: "prior_employer",
      value: "Explicit synthetic assertion",
      source: { kind: "explicit_user", confirmed: true },
    };
    const f = fixture([explicit]);
    expect(() =>
      validateManifestScreeningSources(f.manifest, f.record, settings, null),
    ).not.toThrow();
  });
  test("rejects altered snapshot bytes, foreign records and answers detached from citations", () => {
    const f = fixture();
    expect(() =>
      validateScreeningSnapshot({ ...f.record, id: crypto.randomUUID() }, settings, evidence),
    ).toThrow("snapshot differs");
    expect(() =>
      validateScreeningSnapshot(
        {
          ...f.record,
          details: {
            ...f.record.details,
            screeningAnswers: { ...f.snapshot, createdAt: "tampered" },
          },
        },
        settings,
        evidence,
      ),
    ).toThrow("snapshot differs");
    expect(() =>
      validateManifestScreeningSources(
        { ...f.manifest, answers: [{ key: "position", fieldName: "position", value: "Invented" }] },
        f.record,
        settings,
        evidence,
      ),
    ).toThrow("exact source citations");
    expect(() =>
      validateManifestScreeningSources(
        { ...f.manifest, screeningAnswerSnapshotHash: "0".repeat(64) },
        f.record,
        settings,
        evidence,
      ),
    ).toThrow("Frozen screening");
    expect(() =>
      validateManifestScreeningSources(
        { answers: [{ key: "position", value: "Invented" }] },
        { ...f.record, details: {} },
        settings,
        evidence,
      ),
    ).toThrow("exact source citations");
    expect(() =>
      validateManifestScreeningSources(
        { answers: [] },
        { ...f.record, details: {} },
        settings,
        evidence,
      ),
    ).not.toThrow();
  });
});

test("omitted and overridden original source facts cannot survive through a current evidence ID", () => {
  const current = {
    ...evidence,
    details: {
      manifest: {
        leaves: [
          { pointer: "/testScore", value: 700 },
          { pointer: "/work/metric", value: "Generated 99 percent growth" },
          { pointer: "/name", value: "Synthetic Applicant" },
        ],
      },
      resolution: {
        document: {
          basics: { name: "Synthetic Applicant" },
          education: [{ testScore: 710 }],
          experience: [],
        },
      },
    },
  };
  const source = (pointer: string, value: string): PersonalScreeningAnswer => ({
    key: "fact",
    value,
    source: { kind: "resume", evidenceId: current.id, sourceHash: current.sourceHash, pointer },
  });
  expect(() =>
    validateScreeningAnswerSources([source("/testScore", "700")], settings, current, "US"),
  ).toThrow("overridden or omitted");
  expect(() =>
    validateScreeningAnswerSources(
      [source("/work/metric", "Generated 99 percent growth")],
      settings,
      current,
      "US",
    ),
  ).toThrow("overridden or omitted");
  expect(() =>
    validateScreeningAnswerSources(
      [source("/name", "Synthetic Applicant")],
      settings,
      current,
      "US",
    ),
  ).not.toThrow();
  expect(() =>
    validateScreeningAnswerSources(
      [source("/resolved/education/0/testScore", "710")],
      settings,
      current,
      "US",
    ),
  ).not.toThrow();
  expect(() =>
    validateScreeningAnswerSources(
      [source("/resolved/education/0/testScore", "700")],
      settings,
      current,
      "US",
    ),
  ).toThrow("exactly match");
  expect(() =>
    validateScreeningAnswerSources(
      [source("/resolved/experience/0/metric", "Generated 99 percent growth")],
      settings,
      current,
      "US",
    ),
  ).toThrow("known stored value");
});
