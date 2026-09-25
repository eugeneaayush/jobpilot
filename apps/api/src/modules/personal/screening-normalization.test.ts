import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import {
  type PersonalScreeningAnswer,
  personalScreeningAnswersInputSchema,
} from "@jobpilot/contracts/personal-readiness";
import { manifestHash } from "./persistence-policy";
import {
  validateManifestScreeningSources,
  validateScreeningAnswerSources,
} from "./screening-provenance";
import { describe, expect, test } from "bun:test";

const settings = personalSettingsSchema.parse({});
type Source = Extract<PersonalScreeningAnswer["source"], { kind: "resume_normalized" }>;
const evidence = {
  id: crypto.randomUUID(),
  sourceHash: "a".repeat(64),
  details: {
    manifest: {
      leaves: [
        { pointer: "/education/0/degree", value: "Master of Business Administration Candidate" },
        { pointer: "/education/0/start", value: "Aug 2026 – May 2028" },
        { pointer: "/education/0/end", value: "May 2028" },
        { pointer: "/basics/location", value: "New York, NY" },
        { pointer: "/basics/phone", value: "+12125551212" },
        { pointer: "/basics/country", value: "United States" },
      ],
    },
  },
};
const cases: {
  transformation: Source["transformation"];
  fieldName: string;
  pointer: string;
  value: string;
  countryPointer?: string;
}[] = [
  {
    transformation: "mba_degree_without_candidate",
    fieldName: "degree",
    pointer: "/education/0/degree",
    value: "Master of Business Administration",
  },
  {
    transformation: "education_end_month",
    fieldName: "end_month",
    pointer: "/education/0/start",
    value: "May",
  },
  {
    transformation: "education_end_year",
    fieldName: "end_year",
    pointer: "/education/0/start",
    value: "2028",
  },
  {
    transformation: "us_city_state_label",
    fieldName: "location",
    pointer: "/basics/location",
    value: "New York, New York, United States",
  },
  {
    transformation: "phone_country_label",
    fieldName: "country",
    pointer: "/basics/phone",
    value: "United States +1",
    countryPointer: "/basics/location",
  },
];
function answer(example: (typeof cases)[number]): PersonalScreeningAnswer {
  return {
    key: example.fieldName,
    fieldName: example.fieldName,
    value: example.value,
    source: {
      kind: "resume_normalized",
      evidenceId: evidence.id,
      sourceHash: evidence.sourceHash,
      pointer: example.pointer,
      transformation: example.transformation,
      ...(example.countryPointer ? { countryPointer: example.countryPointer } : {}),
    },
  };
}
function changed(pointer: string, value: string) {
  return {
    ...evidence,
    details: {
      manifest: {
        leaves: evidence.details.manifest.leaves.map((leaf) =>
          leaf.pointer === pointer ? { pointer, value } : leaf,
        ),
      },
    },
  };
}
function validate(input: PersonalScreeningAnswer, current = evidence) {
  return validateScreeningAnswerSources([input], settings, current, null);
}

describe("narrow current-resume ATS normalization", () => {
  test("enumerated formatting changes retain their exact evidence and transformation provenance", () => {
    for (const example of cases) {
      const input = personalScreeningAnswersInputSchema.parse({
        expectedUpdatedAt: new Date().toISOString(),
        answers: [answer(example)],
      });
      expect(input.answers[0]!.source.kind).toBe("resume_normalized");
      expect(() => validate(input.answers[0]!)).not.toThrow();
      expect(input.answers[0]!.source).not.toHaveProperty("confirmed");
    }
    expect(() => validate(answer({ ...cases[1]!, pointer: "/education/0/end" }))).not.toThrow();
    expect(() => validate(answer({ ...cases[2]!, pointer: "/education/0/end" }))).not.toThrow();
  });
  test("does not broaden degree claims or permit loose equivalence", () => {
    const base = answer(cases[0]!);
    for (const value of [
      "MBA",
      "Master of Business Administration ",
      "Completed Master of Business Administration",
      "Doctor of Business Administration",
    ])
      expect(() => validate({ ...base, value })).toThrow("transformation");
    expect(() => validate({ ...base, value: true })).toThrow("textual source");
    for (const value of [
      "MBA Candidate",
      "Master of Business Administration (Candidate)",
      "Bachelor of Business Administration Candidate",
    ])
      expect(() => validate(base, changed("/education/0/degree", value))).toThrow("transformation");
  });
  test("education dates require a real explicit end date, valid chronology and exact requested output", () => {
    const month = answer(cases[1]!);
    const year = answer(cases[2]!);
    for (const value of [
      "Aug 2026",
      "Aug 2026 – Present",
      "Aug 2026 – Maybe 2028",
      "May 2028 – Aug 2026",
      "Fall 2026 – Spring 2028",
      "Aug 2026 – May 2028 (estimated)",
    ])
      expect(() => validate(month, changed("/education/0/start", value))).toThrow("transformation");
    expect(() => validate({ ...month, value: "05" })).toThrow("transformation");
    expect(() => validate({ ...year, value: "2027" })).toThrow("transformation");
    expect(() =>
      validate(
        { ...month, value: "September" },
        changed("/education/0/start", "Aug 2026 - Sep 2028"),
      ),
    ).not.toThrow();
    expect(() =>
      validate(
        answer({ ...cases[1]!, pointer: "/education/0/end" }),
        changed("/education/0/end", "May 2028"),
      ),
    ).not.toThrow();
  });
  test("geographic expansion requires an exact US state abbreviation and no added residence claim", () => {
    const location = answer(cases[3]!);
    for (const value of [
      "New York",
      "Toronto, ON",
      "Vancouver, BC",
      "New York, NY, Canada",
      "New York, New York",
      "New York, ZZ",
    ])
      expect(() => validate(location, changed("/basics/location", value))).toThrow(
        "transformation",
      );
    for (const value of [
      "New York, United States",
      "New York, New York, USA",
      "Houston, Texas, United States",
    ])
      expect(() => validate({ ...location, value })).toThrow("transformation");
  });
  test("a +1 number alone never establishes the US phone dropdown without current US corroboration", () => {
    const phone = answer(cases[4]!);
    const source = phone.source as Source;
    const input = (source: Source) =>
      personalScreeningAnswersInputSchema.safeParse({
        expectedUpdatedAt: new Date().toISOString(),
        answers: [{ ...phone, source }],
      });
    expect(input({ ...source, countryPointer: undefined }).success).toBe(false);
    expect(() => validate(phone, changed("/basics/location", "Toronto, ON"))).toThrow(
      "transformation",
    );
    expect(() => validate(phone, changed("/basics/phone", "+442079460000"))).toThrow(
      "transformation",
    );
    expect(() => validate({ ...phone, value: "Canada +1" })).toThrow("transformation");
    expect(() =>
      validate({ ...phone, source: { ...source, countryPointer: "/education/0/degree" } }),
    ).toThrow("transformation");
    expect(() =>
      validate({ ...phone, source: { ...source, countryPointer: "/basics/country" } }),
    ).not.toThrow();
    expect(input({ ...source, transformation: "us_city_state_label" }).success).toBe(false);
  });
  test("never maps these formatting rules into legal, consent, citizenship or demographic fields", () => {
    for (const example of cases)
      for (const fieldName of [
        "citizenship",
        "work_authorization",
        "consent",
        "demographic_123",
        "question_123",
        undefined,
      ])
        expect(() => validate({ ...answer(example), fieldName })).toThrow("transformation");
  });
  test("superseded and overridden source values fail again at frozen-manifest validation", () => {
    const normalized = answer(cases[0]!);
    expect(() => validate(normalized, { ...evidence, id: crypto.randomUUID() })).toThrow(
      "superseded",
    );
    const current = {
      ...evidence,
      details: {
        ...evidence.details,
        resolution: { document: { education: [{ degree: "Different supported degree" }] } },
      },
    };
    expect(() => validate(normalized, current)).toThrow("overridden or omitted");
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
      answers: [normalized],
    };
    const snapshot = { ...content, snapshotHash: manifestHash(content) };
    record.details.screeningAnswers = snapshot;
    const { source: _source, ...field } = normalized;
    const manifest = {
      answers: [field],
      screeningAnswerSnapshot: snapshot,
      screeningAnswerSnapshotHash: snapshot.snapshotHash,
    };
    expect(() =>
      validateManifestScreeningSources(manifest, record, settings, evidence),
    ).not.toThrow();
    expect(() => validateManifestScreeningSources(manifest, record, settings, current)).toThrow(
      "overridden or omitted",
    );
  });
  test("current resolved document pointers support the same exact transformations", () => {
    const current = {
      ...evidence,
      details: {
        ...evidence.details,
        resolution: {
          document: {
            education: [{ degree: "Master of Business Administration Candidate", end: "May 2028" }],
            basics: { location: "New York, NY", phone: "+12125551212" },
          },
        },
      },
    };
    for (const example of [
      cases[0]!,
      { ...cases[1]!, pointer: "/education/0/end" },
      cases[3]!,
      cases[4]!,
    ]) {
      const normalized = answer({
        ...example,
        pointer: `/resolved${example.pointer}`,
        ...(example.countryPointer ? { countryPointer: `/resolved${example.countryPointer}` } : {}),
      });
      expect(() => validate(normalized, current)).not.toThrow();
    }
  });
});
