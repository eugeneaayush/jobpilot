import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PersonalAttachment,
  PersonalAttachmentRequirements,
} from "@jobpilot/contracts/personal-attachments";
import { personalCoverLetterInputSchema } from "@jobpilot/contracts/personal-attachments";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import type { Prisma } from "@/generated/prisma/client";
import { fetchPublicJobQuestions } from "./attachments.service";
import {
  attachmentStatus,
  greenhouseAttachmentRequirements,
  observedAttachmentRequirements,
  verifyAttachmentManifest,
} from "./attachments-policy";
import { coverLetterContent, generateCoverLetter } from "./document/cover-letter";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { manifestHash } from "./persistence-policy";
import { sha256 } from "./runtime";
import { describe, expect, test } from "bun:test";

const data = {
  ...EMPTY_RESUME_DATA,
  basics: { name: "Synthetic Candidate" },
  experience: [
    {
      company: "Synthetic Employer",
      title: "Analyst",
      start: "2020",
      bullets: ["Built a reporting workflow."],
    },
  ],
};
const job = { title: "Intern", company: "Synthetic Target" };

describe("personal attachment evidence", () => {
  test("absent question inventories fail closed while successful empty inventories stay distinct", () => {
    expect(() => greenhouseAttachmentRequirements({ id: 42 }, "42")).toThrow("absent");
    expect(() => greenhouseAttachmentRequirements({ id: 43, questions: [] }, "42")).toThrow(
      "another",
    );
    expect(greenhouseAttachmentRequirements({ id: 42, questions: [] }, "42")).toEqual([]);
    expect(attachmentStatus(null, []).readiness).toBe("unknown");
    expect(
      personalCoverLetterInputSchema.safeParse({ fieldName: "cover_letter", required: false })
        .success,
    ).toBe(false);
  });

  test("file requirements preserve required cover letters and unknown file kinds", () => {
    const requirements = greenhouseAttachmentRequirements(
      {
        id: 42,
        questions: [
          { label: "Resume/CV", required: true, fields: [{ name: "resume", type: "input_file" }] },
          {
            label: "Cover Letter",
            required: true,
            fields: [
              { name: "cover_letter", type: "input_file" },
              { name: "cover_letter_text", type: "textarea" },
            ],
          },
          {
            label: "Transcript",
            required: true,
            fields: [{ name: "transcript", type: "input_file" }],
          },
        ],
      },
      "42",
    );
    expect(requirements.map((field) => field.kind)).toEqual(["cover_letter", "resume", "other"]);
    expect(() =>
      greenhouseAttachmentRequirements(
        {
          id: 42,
          questions: [
            {
              label: "File",
              required: true,
              fields: [
                { name: "x", type: "input_file" },
                { name: "x", type: "input_file" },
              ],
            },
          ],
        },
        "42",
      ),
    ).toThrow("ambiguous");
  });

  test("rendering preserves cited facts and deterministic immutable PDF bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-pdf-test-"));
    try {
      const before = structuredClone(data);
      const content = coverLetterContent(data, job);
      expect(content.citations).toEqual([
        { pointer: "/basics/name", value: "Synthetic Candidate" },
        { pointer: "/experience/0/title", value: "Analyst" },
        { pointer: "/experience/0/company", value: "Synthetic Employer" },
        { pointer: "/experience/0/bullets/0", value: "Built a reporting workflow." },
      ]);
      const first = await generateCoverLetter(data, job, root);
      const second = await generateCoverLetter(data, job, root);
      expect(first.sha256).toBe(second.sha256);
      expect(first.path).toBe(second.path);
      expect(data).toEqual(before);
      expect((await stat(first.path)).mode & 0o777).toBe(0o600);
      const bytes = await readFile(first.path);
      expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
      expect(sha256(bytes)).toBe(first.sha256);
      const extraction = Bun.spawn(["pdftotext", first.path, "-"], { stdout: "pipe" });
      const text = await new Response(extraction.stdout).text();
      expect(await extraction.exited).toBe(0);
      expect(text).toContain("Built a reporting workflow.");
      expect(text).toContain("Synthetic Target");
      expect(text).not.toContain("MBA");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("investment letters select exact relevant facts across roles without changing chronology or enrollment claims", () => {
    const resume = {
      ...data,
      education: [{ school: "Synthetic School", degree: "MBA, expected 2028", details: [] }],
      experience: [
        {
          company: "Synthetic Hospital",
          title: "Analytics Manager",
          start: "2024",
          bullets: ["Improved a scheduling workflow."],
        },
        {
          company: "Synthetic Payments Firm",
          title: "Venture Analyst",
          start: "2020",
          end: "2023",
          bullets: [
            "Analyzed a $12M investment portfolio.",
            "Built financial valuation models for acquisition reviews.",
          ],
        },
      ],
    };
    const before = structuredClone(resume);
    const content = coverLetterContent(resume, {
      title: "Venture Investment Intern",
      company: "Synthetic Fund",
    });
    expect(resume).toEqual(before);
    expect(content.paragraphs).toContain(
      "My education includes MBA, expected 2028 at Synthetic School.",
    );
    expect(content.paragraphs).toContain(
      "My experience includes Analytics Manager at Synthetic Hospital.",
    );
    expect(content.paragraphs.join("\n")).toContain("Analyzed a $12M investment portfolio.");
    expect(content.paragraphs.join("\n")).toContain(
      "Built financial valuation models for acquisition reviews.",
    );
    expect(content.paragraphs.join("\n")).not.toContain("currently enrolled");
    expect(content.citations).toContainEqual({
      pointer: "/experience/1/bullets/0",
      value: "Analyzed a $12M investment portfolio.",
    });
    expect(content.citations).toContainEqual({
      pointer: "/education/0/degree",
      value: "MBA, expected 2028",
    });
  });

  test("bounded public fetch refuses unsuccessful or oversized question data", async () => {
    const request = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchPublicJobQuestions("https://example.test", request)).rejects.toThrow("429");
    const huge = (async () => new Response("x".repeat(1_000_001))) as unknown as typeof fetch;
    await expect(fetchPublicJobQuestions("https://example.test", huge)).rejects.toThrow("bounded");
  });

  test("attempts bind required reviews, exact field identity, source evidence and private hashes", async () => {
    const previous = process.env.JOBPILOT_PERSONAL_ROOT;
    const root = await mkdtemp(join(tmpdir(), "attachment-manifest-test-"));
    process.env.JOBPILOT_PERSONAL_ROOT = root;
    try {
      const userId = crypto.randomUUID();
      const artifactRoot = join(root, "storage", userId);
      await mkdir(artifactRoot, { recursive: true });
      const path = join(artifactRoot, "letter.pdf");
      const sourcePath = join(artifactRoot, "questions.json");
      await writeFile(path, "Synthetic attachment bytes");
      await writeFile(sourcePath, '{"questions":[]}');
      const posting = { source: "greenhouse", content: "Synthetic posting" };
      const inventory: PersonalAttachmentRequirements = {
        schemaVersion: 1,
        identity: "greenhouse:synthetic:42",
        postingContentHash: manifestHash(posting),
        source: {
          kind: "greenhouse_questions",
          url: "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/42?questions=true",
          path: sourcePath,
          sha256: sha256('{"questions":[]}'),
          capturedAt: new Date().toISOString(),
        },
        requirements: [
          {
            fieldName: "cover_letter",
            label: "Cover Letter",
            required: true,
            kind: "cover_letter",
          },
        ],
      };
      const evidence = { id: crypto.randomUUID(), sourceHash: "a".repeat(64) };
      const attachment: PersonalAttachment = {
        id: crypto.randomUUID(),
        kind: "cover_letter",
        fieldName: "cover_letter",
        label: "Cover Letter",
        required: true,
        identity: inventory.identity,
        postingContentHash: inventory.postingContentHash,
        path,
        sha256: sha256("Synthetic attachment bytes"),
        bytes: 26,
        createdAt: new Date().toISOString(),
        source: {
          resumeEvidenceId: evidence.id,
          sourceHash: evidence.sourceHash,
          resumeDataHash: manifestHash(data),
          citations: coverLetterContent(data, job).citations,
        },
        review: null,
      };
      const record = {
        id: crypto.randomUUID(),
        identity: inventory.identity,
        details: { posting, attachmentRequirements: inventory, attachments: [attachment] },
      };
      const db = { personalAttempt: { findMany: async () => [] } } as unknown as Pick<
        Prisma.TransactionClient,
        "personalAttempt"
      >;
      const oldAttemptId = crypto.randomUUID();
      await mkdir(join(artifactRoot, "inspections"));
      await writeFile(
        join(artifactRoot, "inspections", `${oldAttemptId}.json`),
        "stale inspection must not be read",
      );
      const oldInspectionDb = {
        personalAttempt: {
          findMany: async () => [
            {
              id: oldAttemptId,
              manifest: { identity: record.identity, postingContentHash: "b".repeat(64) },
            },
          ],
        },
      } as unknown as Pick<Prisma.TransactionClient, "personalAttempt">;
      expect(await observedAttachmentRequirements(oldInspectionDb, userId, record)).toBeNull();
      const manifest = { attachmentRequirements: inventory, attachments: [attachment] };
      await expect(
        verifyAttachmentManifest(db, userId, record, manifest, true, evidence),
      ).rejects.toThrow("incomplete");
      expect(attachmentStatus(inventory, [attachment]).missingRequired).toEqual(["Cover Letter"]);
      attachment.review = {
        pdfHash: attachment.sha256,
        inspected: true,
        notes: "Synthetic test",
        reviewedAt: new Date().toISOString(),
        reviewer: userId,
      };
      // Historical visual review alone cannot grandfather an artifact into live readiness.
      expect(attachmentStatus(inventory, [attachment]).readiness).toBe("draft");
      attachment.verification = {
        status: "passed",
        artifactSha256: attachment.sha256,
        verifierVersion: "1",
        verifierConfigHash: documentPipelineInputs("cbs-cover-letter").verifierConfigHash,
        renderer: "cbs-cover-letter",
        pageCount: 1,
        extractedCharacters: 100,
        checks: [
          "artifact_hash",
          "page_limit",
          "text_layer",
          "glyphs",
          "renderer_margins",
          "layout_bounds",
        ].map((code) => ({
          code,
          status: "passed" as const,
          message: "Synthetic boundary fixture",
        })),
      };
      expect(attachmentStatus(inventory, [attachment]).readiness).toBe("draft");
      attachment.pipeline = {
        ...documentPipelineInputs("cbs-cover-letter"),
        renderer: "cbs-cover-letter",
      };
      const reportBytes = JSON.stringify(attachment.verification, null, 2);
      const reportPath = join(artifactRoot, "document-checks", `${sha256(reportBytes)}.json`);
      await mkdir(join(artifactRoot, "document-checks"));
      await writeFile(reportPath, reportBytes, { mode: 0o600 });
      for (const field of [
        "rendererConfigHash",
        "verifierConfigHash",
        "documentPipelineVersion",
      ] as const) {
        const stale = {
          ...attachment,
          pipeline: { ...attachment.pipeline, [field]: "0".repeat(64) },
        };
        expect(attachmentStatus(inventory, [stale]).readiness).toBe("draft");
      }
      expect(
        attachmentStatus(inventory, [
          {
            ...attachment,
            verification: { ...attachment.verification, verifierConfigHash: "0".repeat(64) },
          },
        ]).readiness,
      ).toBe("draft");
      expect(
        attachmentStatus(inventory, [
          {
            ...attachment,
            verification: { ...attachment.verification, artifactSha256: "0".repeat(64) },
          },
        ]).readiness,
      ).toBe("draft");
      await verifyAttachmentManifest(db, userId, record, manifest, true, evidence);
      await rm(reportPath);
      await expect(
        verifyAttachmentManifest(db, userId, record, manifest, true, evidence),
      ).rejects.toThrow();
      await writeFile(reportPath, reportBytes, { mode: 0o600 });
      await expect(
        verifyAttachmentManifest(
          db,
          userId,
          record,
          { ...manifest, attachments: [] },
          true,
          evidence,
        ),
      ).rejects.toThrow("differ");
      await expect(
        verifyAttachmentManifest(db, userId, record, manifest, true, {
          ...evidence,
          id: crypto.randomUUID(),
        }),
      ).rejects.toThrow("resume evidence");
      await expect(
        verifyAttachmentManifest(
          db,
          userId,
          record,
          { ...manifest, attachments: [{ ...attachment, fieldName: "other" }] },
          true,
          evidence,
        ),
      ).rejects.toThrow("differ");
      await writeFile(path, "tampered bytes");
      await expect(
        verifyAttachmentManifest(db, userId, record, manifest, true, evidence),
      ).rejects.toThrow("SHA256");
    } finally {
      if (previous === undefined) delete process.env.JOBPILOT_PERSONAL_ROOT;
      else process.env.JOBPILOT_PERSONAL_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
