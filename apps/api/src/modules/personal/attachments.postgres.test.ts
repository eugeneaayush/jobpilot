import { readFile } from "node:fs/promises";
import { personalAttachmentsResponseSchema } from "@jobpilot/contracts/personal-attachments";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { PersonalAttachmentsService } from "./attachments.service";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { PersonalService } from "./personal.service";
import { PersonalPreviewService } from "./preview.service";
import { PersonalReadinessService } from "./readiness.service";
import { objectValue } from "./runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal attachment persistence", () => {
  let db: PersonalTestDatabase;
  let service: PersonalAttachmentsService;
  let previews: PersonalPreviewService;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
    const personal = new PersonalService(db.prisma, new PersonalReadinessService(db.prisma));
    service = new PersonalAttachmentsService(db.prisma, personal);
    previews = new PersonalPreviewService(db.prisma, personal);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  test("required letters need exact rendered review, remain private, and survive preview regeneration", async () => {
    const f = await personalFixture(db);
    const other = await personalFixture(db);
    const { record } = await f.record("42");
    await db.prisma.resume.create({
      data: {
        id: f.resume.resumeId,
        userId: f.user.id,
        label: "Synthetic test resume",
        content: JSON.stringify({
          ...EMPTY_RESUME_DATA,
          basics: { name: "Synthetic Candidate" },
          experience: [
            {
              company: "Synthetic Firm",
              title: "Analyst",
              start: "2020",
              bullets: ["Evaluated investment proposals."],
            },
          ],
        }),
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(
        "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/42?questions=true",
      );
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      return Response.json({
        id: 42,
        questions: [
          { label: "Resume/CV", required: true, fields: [{ name: "resume", type: "input_file" }] },
          {
            label: "Cover Letter",
            required: true,
            fields: [{ name: "cover_letter", type: "input_file" }],
          },
        ],
      });
    }) as typeof fetch;
    try {
      const refreshed = await service.refresh(f.user.id, record.id);
      expect(refreshed.missingRequired).toEqual(["Cover Letter"]);
      personalAttachmentsResponseSchema.parse(refreshed);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await expect(service.get(other.user.id, record.id)).rejects.toThrow("not found");
    await expect(
      service.coverLetter(f.user.id, record.id, { fieldName: "invented" }),
    ).rejects.toThrow("saved employer");
    const draft = await service.coverLetter(f.user.id, record.id, { fieldName: "cover_letter" });
    const document = draft.documents[0]!;
    expect(document).not.toHaveProperty("path");
    expect(document.review).toBeNull();
    expect(draft.readiness).toBe("draft");
    const pdf = await service.pdf(f.user.id, record.id, document.sha256);
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe("%PDF");
    await expect(service.pdf(other.user.id, record.id, document.sha256)).rejects.toThrow(
      "not found",
    );
    await expect(
      service.review(f.user.id, record.id, {
        attachmentId: document.id,
        pdfHash: "a".repeat(64),
        inspected: true,
        notes: "Synthetic",
      }),
    ).rejects.toThrow("different");
    const reviewed = await service.review(f.user.id, record.id, {
      attachmentId: document.id,
      pdfHash: document.sha256,
      inspected: true,
      notes: "Inspected synthetic test PDF",
    });
    expect(reviewed.readiness).toBe("ready");
    expect(reviewed.requiresPreview).toBe(true);
    personalAttachmentsResponseSchema.parse(reviewed);
    const preview = await previews.preview(f.user.id, record.id);
    const ready = await previews.review(f.user.id, record.id, {
      pdfHash: preview.preview!.pdfHash,
      inspected: true,
      notes: "Inspected synthetic resume",
    });
    expect(ready.preview?.readiness).toBe("ready");
    const prepared = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    const previousPath = String(objectValue(prepared.details).manifestPath);
    const manifest = objectValue(JSON.parse(await readFile(previousPath, "utf8")));
    expect(objectValue((manifest.attachments as unknown[])[0]).sha256).toBe(document.sha256);
    await previews.preview(f.user.id, record.id);
    const again = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(
      (objectValue(again.details).previewHistory as unknown[])
        .map(objectValue)
        .some((entry) => entry.manifestPath === previousPath),
    ).toBe(true);
    expect(await readFile(previousPath, "utf8")).toContain(document.sha256);
    await service.coverLetter(f.user.id, record.id, { fieldName: "cover_letter" });
    expect((await service.get(f.user.id, record.id)).documents[0]?.review).toBeNull();
    expect((await service.pdf(f.user.id, record.id, document.sha256)).status).toBe(200);
  });
});
