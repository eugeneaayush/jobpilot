import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { manifestHash } from "./persistence-policy";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { PersonalReadinessService } from "./readiness.service";
import { PersonalRecoveryService } from "./recovery.service";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal screening answer snapshots", () => {
  let db: PersonalTestDatabase;
  let service: PersonalReadinessService;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
    service = new PersonalReadinessService(db.prisma);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("scopes record and resume evidence references to their owner", async () => {
    const f = await personalFixture(db);
    const other = await personalFixture(db);
    const { record } = await f.record();
    await expect(service.answers(other.user.id, record.id)).rejects.toThrow("not found");
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        expectedUpdatedAt: record.updatedAt.toISOString(),
        answers: [
          {
            key: "name",
            value: "Synthetic Candidate",
            source: {
              kind: "resume",
              evidenceId: other.resume.id,
              sourceHash: other.resume.sourceHash,
              pointer: "/name",
            },
          },
        ],
      }),
    ).rejects.toThrow("superseded resume evidence");
  });

  it("appends exact cited snapshots while preserving unknown facts and real conflicts", async () => {
    const f = await personalFixture(db);
    const { record } = await f.record();
    await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: {
        details: {
          conflicts: ["Unresolved degree date"],
          manifest: { leaves: [{ pointer: "/name", value: "Synthetic Candidate" }] },
        },
      },
    });
    const withMissing = await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: {
          ...objectValue(record.details),
          missingAnswers: ["Citizenship"],
          preview: {
            ...objectValue(objectValue(record.details).preview),
            conflicts: ["Unresolved degree date"],
          },
        },
      },
    });
    const first = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: withMissing.updatedAt.toISOString(),
      answers: [
        {
          key: "name",
          value: "Synthetic Candidate",
          fieldName: "applicant_name",
          source: {
            kind: "resume",
            evidenceId: f.resume.id,
            sourceHash: f.resume.sourceHash,
            pointer: "/name",
          },
        },
      ],
    });
    expect(first.snapshot.answers[0]?.source).toMatchObject({ kind: "resume", pointer: "/name" });
    const second = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: first.updatedAt.toISOString(),
      answers: [
        {
          key: "custom",
          value: "User supplied exact answer",
          source: { kind: "explicit_user", confirmed: true },
        },
      ],
    });
    expect(second.snapshot.snapshotHash).not.toBe(first.snapshot.snapshotHash);
    const stored = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    const details = objectValue(stored.details);
    expect(details.screeningAnswerSnapshots).toEqual([first.snapshot, second.snapshot]);
    expect(details.missingAnswers).toEqual(["Citizenship"]);
    expect(details.preview).toMatchObject({
      readiness: "draft",
      renderReviewed: false,
      conflicts: ["Unresolved degree date"],
    });
    expect(
      (await db.prisma.personalResumeEvidence.findUniqueOrThrow({ where: { id: f.resume.id } }))
        .details,
    ).toMatchObject({ conflicts: ["Unresolved degree date"] });
  });

  it("rejects unknown settings, stale hashes, ungrounded values and stale updates", async () => {
    const f = await personalFixture(db, "submit", 3, false);
    f.settings.citizenship = null;
    await writeFile(join(db.root, "settings", `${f.user.id}.json`), JSON.stringify(f.settings));
    const { record } = await f.record();
    const base = {
      expectedUpdatedAt: record.updatedAt.toISOString(),
      answers: [
        {
          key: "citizenship",
          value: "US",
          source: {
            kind: "settings" as const,
            settingsHash: manifestHash(f.settings),
            pointer: "/citizenship",
          },
        },
      ],
    };
    await expect(service.saveAnswers(f.user.id, record.id, base)).rejects.toThrow("exactly match");
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        ...base,
        answers: [
          {
            ...base.answers[0]!,
            source: { ...base.answers[0]!.source, settingsHash: "0".repeat(64) },
          },
        ],
      }),
    ).rejects.toThrow("settings changed");
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        ...base,
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
    ).rejects.toThrow("Record changed");
  });

  it("retains boolean source citations and never guesses string-to-checkbox conversions", async () => {
    const f = await personalFixture(db);
    const { record } = await f.record();
    await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: { details: { manifest: { leaves: [{ pointer: "/consent", value: false }] } } },
    });
    const source = {
      kind: "resume" as const,
      evidenceId: f.resume.id,
      sourceHash: f.resume.sourceHash,
      pointer: "/consent",
    };
    const result = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: record.updatedAt.toISOString(),
      answers: [
        { key: "consent", value: false, source },
        { key: "confirmed", value: true, source: { kind: "explicit_user", confirmed: true } },
      ],
    });
    expect(result.snapshot.answers[0]).toEqual({ key: "consent", value: false, source });
    expect(result.snapshot.answers[1]?.value).toBe(true);
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        expectedUpdatedAt: result.updatedAt.toISOString(),
        answers: [{ key: "consent", value: true, source }],
      }),
    ).rejects.toThrow("exactly match");
  });

  it("reads only the latest owned attempt's bounded private question metadata", async () => {
    const f = await personalFixture(db, "offline");
    const other = await personalFixture(db, "offline");
    const { record, input } = await f.record();
    const attempt = await db.service.start(f.user.id, input);
    const { attachmentRequirements: _inventory, ...localDetails } = objectValue(record.details);
    await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: { details: jsonValue(localDetails) },
    });
    const directory = join(db.root, "storage", f.user.id, "inspections");
    await mkdir(directory);
    const file = join(directory, `${attempt.id}.json`);
    const field = {
      name: "consent",
      label: "I confirm",
      type: "checkbox",
      required: true,
      value: "private-value",
      options: ["private-option"],
      ref: "opaque",
    };
    await writeFile(file, JSON.stringify({ attemptId: attempt.id, fields: [field] }));
    expect((await service.answers(f.user.id, record.id)).questions).toEqual([
      { fieldName: "consent", label: "I confirm", type: "checkbox", required: true },
    ]);
    await expect(service.answers(other.user.id, record.id)).rejects.toThrow("not found");
    await writeFile(file, JSON.stringify({ attemptId: crypto.randomUUID(), fields: [field] }));
    await expect(service.answers(f.user.id, record.id)).rejects.toThrow(
      "invalid question metadata",
    );
    const outside = join(db.root, "storage", other.user.id, "foreign-inspection.json");
    await writeFile(outside, JSON.stringify({ attemptId: attempt.id, fields: [field] }));
    await rm(file);
    await symlink(outside, file);
    expect((await service.answers(f.user.id, record.id)).questions).toEqual([]);
    await rm(file);
    await writeFile(
      file,
      JSON.stringify({ attemptId: attempt.id, fields: Array.from({ length: 501 }, () => field) }),
    );
    await expect(service.answers(f.user.id, record.id)).rejects.toThrow(
      "invalid question metadata",
    );
  });
  it("shows current public questions without file alternatives and rejects corrupted or mis-scoped evidence", async () => {
    const f = await personalFixture(db, "offline");
    const { record } = await f.record();
    const directory = join(db.root, "storage", f.user.id, "questions");
    await mkdir(directory, { recursive: true });
    const fields = [
      {
        label: "Resume/CV",
        required: true,
        fields: [
          { name: "resume", type: "input_file" },
          { name: "resume_text", type: "textarea" },
        ],
      },
      {
        label: "Cover Letter",
        required: false,
        fields: [
          { name: "cover_letter", type: "input_file" },
          { name: "cover_letter_text", type: "textarea" },
        ],
      },
      { label: "SQL experience", required: true, fields: [{ name: "sql", type: "input_text" }] },
      {
        label: "Preferred teams",
        required: true,
        fields: [
          {
            name: "question_42",
            type: "multi_value_multi_select",
            values: [
              { value: 901, label: "Research" },
              { value: 902, label: "Trading" },
            ],
          },
        ],
      },
    ];
    const inventory = objectValue(objectValue(record.details).attachmentRequirements);
    async function store(id = record.requisitionId, changes: Record<string, unknown> = {}) {
      const bytes = JSON.stringify({ id, questions: fields });
      const file = join(directory, `${sha256(bytes)}.json`);
      await writeFile(file, bytes);
      const next = {
        ...inventory,
        ...changes,
        source: {
          kind: "greenhouse_questions",
          path: file,
          sha256: sha256(bytes),
          url: "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/123?questions=true",
          capturedAt: new Date().toISOString(),
        },
      };
      await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: {
          details: jsonValue({ ...objectValue(record.details), attachmentRequirements: next }),
        },
      });
      return file;
    }
    const file = await store();
    const packet = await service.answers(f.user.id, record.id);
    expect(packet.questions).toEqual([
      { fieldName: "sql", label: "SQL experience", type: "input_text", required: true },
      {
        fieldName: "question_42",
        label: "Preferred teams",
        type: "multi_value_multi_select",
        required: true,
        multiple: true,
        options: [
          { value: "901", label: "Research" },
          { value: "902", label: "Trading" },
        ],
      },
    ]);
    const answer = {
      key: "teams",
      fieldName: "question_42",
      value: ["901", "902"],
      source: { kind: "explicit_user" as const, confirmed: true as const },
    };
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        expectedUpdatedAt: packet.updatedAt.toISOString(),
        answers: [{ ...answer, value: ["Research"] }],
      }),
    ).rejects.toThrow("option inventory");
    const saved = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: packet.updatedAt.toISOString(),
      answers: [answer],
    });
    expect(saved.snapshot.answers[0]?.value).toEqual(["901", "902"]);
    await writeFile(file, "tampered");
    await expect(service.answers(f.user.id, record.id)).rejects.toThrow("hash mismatch");
    await store("different-requisition");
    await expect(service.answers(f.user.id, record.id)).rejects.toThrow("another requisition");
    await store(record.requisitionId, { postingContentHash: "0".repeat(64) });
    await expect(service.answers(f.user.id, record.id)).rejects.toThrow("earlier posting");
    await store(record.requisitionId, { identity: "greenhouse:other:123" });
    await expect(service.answers(f.user.id, record.id)).rejects.toThrow("earlier posting");
  });
  it("rejects historical and resolved-away resume facts when saving screening answers", async () => {
    const f = await personalFixture(db, "offline");
    const { record } = await f.record();
    await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: {
        details: {
          manifest: { leaves: [{ pointer: "/score", value: 700 }] },
          resolution: { document: { education: [{ score: 710 }] } },
        },
      },
    });
    const answer = {
      key: "score",
      value: "700",
      source: {
        kind: "resume" as const,
        evidenceId: f.resume.id,
        sourceHash: f.resume.sourceHash,
        pointer: "/score",
      },
    };
    const input = { expectedUpdatedAt: record.updatedAt.toISOString(), answers: [answer] };
    await expect(service.saveAnswers(f.user.id, record.id, input)).rejects.toThrow(
      "overridden or omitted",
    );
    const corrected = await service.saveAnswers(f.user.id, record.id, {
      ...input,
      answers: [
        {
          ...answer,
          value: "710",
          source: { ...answer.source, pointer: "/resolved/education/0/score" },
        },
      ],
    });
    await db.prisma.personalResumeEvidence.create({
      data: {
        userId: f.user.id,
        resumeId: f.resume.resumeId,
        sourceHash: f.resume.sourceHash,
        createdAt: new Date(Date.now() + 10),
        details: { manifest: { leaves: [{ pointer: "/score", value: 700 }] } },
      },
    });
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        ...input,
        expectedUpdatedAt: corrected.updatedAt.toISOString(),
      }),
    ).rejects.toThrow("superseded resume evidence");
  });
  it("recomputes required employer disclosures from exact fields while preserving eligibility and other unknowns", async () => {
    const f = await personalFixture(db, "offline");
    const { record } = await f.record();
    const questions = [
      { label: "Full name", required: true, fields: [{ name: "full_name", type: "input_text" }] },
      {
        label: "Broker dealer affiliation",
        required: true,
        fields: [{ name: "broker_affiliation", type: "input_text" }],
      },
      {
        label: "Government service",
        required: true,
        fields: [{ name: "government_service", type: "input_text" }],
      },
      {
        label: "Graduation cohort",
        required: true,
        fields: [{ name: "graduation", type: "input_text" }],
      },
      {
        label: "Resume/CV",
        required: true,
        fields: [
          { name: "resume", type: "input_file" },
          { name: "resume_text", type: "textarea" },
        ],
      },
    ];
    const bytes = JSON.stringify({ id: record.requisitionId, questions });
    const file = join(db.root, "storage", f.user.id, `${sha256(bytes)}.json`);
    await writeFile(file, bytes);
    const inventory = objectValue(objectValue(record.details).attachmentRequirements);
    const current = await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...objectValue(record.details),
          attachmentRequirements: {
            ...inventory,
            source: { ...objectValue(inventory.source), path: file, sha256: sha256(bytes) },
          },
          missingAnswers: ["Full name", "Graduation cohort", "Pending manual review"],
          evaluation: {
            requirements: [
              {
                requirement: "Graduation cohort",
                status: "unknown",
                evidence: "Must graduate in the specified cohort",
                candidateEvidence: null,
              },
            ],
          },
        }),
      },
    });
    const explicit = { kind: "explicit_user" as const, confirmed: true as const };
    const known = [
      { key: "name", fieldName: "full_name", value: "Synthetic Person", source: explicit },
      { key: "cohort", fieldName: "graduation", value: "2028", source: explicit },
    ];
    const first = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: current.updatedAt.toISOString(),
      answers: [
        ...known,
        { key: "unique_label", label: "Broker dealer affiliation", value: "No", source: explicit },
        {
          key: "government_service",
          fieldName: "wrong_field",
          label: "Government service",
          value: false,
          source: explicit,
        },
      ],
    });
    const missing = async () =>
      objectValue(
        (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).details,
      ).missingAnswers;
    expect(await missing()).toEqual([
      "Graduation cohort",
      "Pending manual review",
      "Government service",
    ]);
    expect(first.questions.some((question) => question.fieldName === "resume_text")).toBe(false);
    const second = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: first.updatedAt.toISOString(),
      answers: [
        ...known,
        {
          key: "broker_affiliation",
          fieldName: "broker_affiliation",
          value: false,
          source: explicit,
        },
        { key: "government", fieldName: "government_service", value: false, source: explicit },
      ],
    });
    expect(await missing()).toEqual(["Graduation cohort", "Pending manual review"]);
    await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: second.updatedAt.toISOString(),
      answers: [
        ...known,
        {
          key: "broker_affiliation",
          fieldName: "broker_affiliation",
          value: " ",
          source: explicit,
        },
      ],
    });
    expect(await missing()).toEqual([
      "Graduation cohort",
      "Pending manual review",
      "Broker dealer affiliation",
      "Government service",
    ]);
  });

  it("invalidates screening-cited eligibility without changing immutable history or unrelated resume decisions", async () => {
    const f = await personalFixture(db, "offline");
    const { record } = await f.record();
    const clauses = ["Candidates must disclose affiliation.", "Candidates must hold a degree."];
    const originalPosting = objectValue(objectValue(record.details).posting);
    const posting = {
      ...originalPosting,
      descriptionText: [originalPosting.descriptionText, ...clauses].join("\n"),
    };
    const inventory = {
      ...objectValue(objectValue(record.details).attachmentRequirements),
      postingContentHash: manifestHash(posting),
    };
    await db.prisma.personalResumeEvidence.update({
      where: { id: f.resume.id },
      data: {
        details: {
          conflicts: [],
          manifest: { leaves: [{ pointer: "/degree", value: "Degree confirmed" }] },
        },
      },
    });
    const current = await db.prisma.personalRecord.update({
      where: { id: record.id },
      data: {
        details: jsonValue({
          ...objectValue(record.details),
          posting,
          attachmentRequirements: inventory,
          evaluation: {
            requirements: clauses.map((evidence, index) => ({
              requirement: index === 0 ? "Affiliation" : "Degree",
              status: "unknown",
              evidence,
              candidateEvidence: null,
            })),
          },
        }),
      },
    });
    const answer = {
      key: "affiliation",
      fieldName: "affiliation",
      value: false,
      source: { kind: "explicit_user" as const, confirmed: true as const },
    };
    const saved = await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: current.updatedAt.toISOString(),
      answers: [answer],
    });
    const recovery = new PersonalRecoveryService(db.prisma);
    const before = await recovery.get(f.user.id, record.id);
    const reviewed = await recovery.adjudicate(f.user.id, record.id, {
      expectedUpdatedAt: before.updatedAt.toISOString(),
      context: before.context,
      decisions: [
        {
          requirementId: before.requirements[0]!.id,
          status: "satisfied",
          rationale: "The owner supplied the exact affiliation disclosure",
          sourceQuote: clauses[0]!,
          citation: {
            kind: "screening_answer",
            snapshotHash: saved.snapshot.snapshotHash,
            key: "affiliation",
            value: false,
          },
        },
        {
          requirementId: before.requirements[1]!.id,
          status: "satisfied",
          rationale: "The exact degree fact is present in source evidence",
          sourceQuote: clauses[1]!,
          citation: { kind: "resume", pointer: "/degree", value: "Degree confirmed" },
        },
      ],
    });
    expect(reviewed.eligibility).toBe("eligible");
    const prior = objectValue(
      (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).details,
    );
    await service.saveAnswers(f.user.id, record.id, {
      expectedUpdatedAt: reviewed.updatedAt.toISOString(),
      answers: [{ ...answer, value: true }],
    });
    const after = objectValue(
      (await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } })).details,
    );
    expect(after.eligibility).toMatchObject({ decision: "unknown" });
    expect(after.missingAnswers).toEqual(["Affiliation"]);
    expect(after.eligibilityAdjudicationHistory).toEqual(prior.eligibilityAdjudicationHistory);
    expect(after.eligibilityAdjudication).toEqual(prior.eligibilityAdjudication);
    const effective = await recovery.get(f.user.id, record.id);
    expect(effective.requirements.map((requirement) => requirement.status)).toEqual([
      "unknown",
      "satisfied",
    ]);
  });
  it("refuses answer replacement while an attempt owns the record", async () => {
    const f = await personalFixture(db, "offline");
    const { record, input } = await f.record();
    await db.service.start(f.user.id, input);
    await expect(
      service.saveAnswers(f.user.id, record.id, {
        expectedUpdatedAt: record.updatedAt.toISOString(),
        answers: [],
      }),
    ).rejects.toThrow("active attempt");
  });
});
