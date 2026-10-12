import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  deleteResumeFile,
  ensureResumesDir,
  generateResumeFilename,
  resumePath,
} from "@/common/storage/storage";
import type { PrismaClient } from "@/generated/prisma/client";
import { ResumeFileService } from "./files/file.service";
import { ResumeService } from "./resume.service";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";

const accountGone = new Error("Foreign key constraint violated: resumes_user_id_fkey");
const pdf = () =>
  new File([new Uint8Array([37, 80, 68, 70])], "cv.pdf", { type: "application/pdf" });

// Every file a test may have written, removed after each test whatever its outcome.
const written: string[] = [];
afterEach(async () => {
  await Promise.all(written.splice(0).map(deleteResumeFile));
});

describe("ResumeService.createFromUpload", () => {
  it("removes the file it wrote when the row cannot be created", async () => {
    let filename = "";
    const db = {
      resume: {
        create: async (args: { data: { sourceFilename: string } }) => {
          filename = args.data.sourceFilename;
          written.push(filename);
          throw accountGone;
        },
      },
    } as unknown as PrismaClient;

    await expect(new ResumeService(db).createFromUpload("u1", pdf())).rejects.toBe(accountGone);

    expect(filename).not.toBe("");
    expect(existsSync(resumePath(filename))).toBe(false);
  });

  it("keeps the file once its row exists", async () => {
    let filename = "";
    const db = {
      resume: {
        create: async (args: { data: { sourceFilename: string } }) => {
          filename = args.data.sourceFilename;
          written.push(filename);
          return { id: "r1" };
        },
        count: async () => 2,
      },
    } as unknown as PrismaClient;

    expect(await new ResumeService(db).createFromUpload("u1", pdf())).toEqual({ id: "r1" });
    expect(existsSync(resumePath(filename))).toBe(true);
  });
});

describe("ResumeFileService.uploadSource", () => {
  async function withOldSource(update: (args: { data: { sourceFilename: string } }) => unknown) {
    const oldFile = `old-${crypto.randomUUID()}.pdf`;
    await ensureResumesDir();
    await writeFile(resumePath(oldFile), "old");
    written.push(oldFile);
    const db = {
      resume: {
        findFirst: async () => ({ id: "r1", userId: "u1", sourceFilename: oldFile }),
        update: async (args: { data: { sourceFilename: string } }) => update(args),
      },
    } as unknown as PrismaClient;
    return { service: new ResumeFileService(db), oldFile };
  }

  it("removes the new file and keeps the old source when the update fails", async () => {
    let newFile = "";
    const { service, oldFile } = await withOldSource((args) => {
      newFile = args.data.sourceFilename;
      written.push(newFile);
      throw accountGone;
    });

    await expect(service.uploadSource("u1", "r1", pdf())).rejects.toBe(accountGone);

    expect(existsSync(resumePath(newFile))).toBe(false);
    expect(existsSync(resumePath(oldFile))).toBe(true);
  });

  it("replaces the old source once the row points at the new file", async () => {
    const { service, oldFile } = await withOldSource((args) => {
      written.push(args.data.sourceFilename);
      return { id: "r1" };
    });

    const result = await service.uploadSource("u1", "r1", pdf());

    expect(existsSync(resumePath(result.sourceFilename))).toBe(true);
    expect(existsSync(resumePath(oldFile))).toBe(false);
  });
});

describe("generateResumeFilename", () => {
  it("names two same-millisecond uploads of one file differently", () => {
    setSystemTime(new Date("2026-10-12T12:00:00Z"));
    try {
      expect(generateResumeFilename("Resume.pdf")).not.toBe(generateResumeFilename("Resume.pdf"));
    } finally {
      setSystemTime();
    }
  });
});
