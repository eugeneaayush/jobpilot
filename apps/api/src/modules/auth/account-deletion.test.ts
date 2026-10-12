import { confirmsAccountEmail } from "@jobpilot/contracts/auth";
import { HttpError } from "@/common/errors";
import type { PrismaClient } from "@/generated/prisma/client";
import { deleteAccountRecords } from "./account-deletion";
import { describe, expect, it } from "bun:test";

interface StoredResume {
  id: string;
  sourceFilename: string | null;
  variants: { id: string }[];
}

function fakePrisma(options: { attempts?: number; resumes?: StoredResume[] } = {}) {
  const calls: string[] = [];
  const deleted: string[] = [];
  const db = {
    personalAttempt: {
      count: async (args: { where: { userId: string } }) => {
        calls.push(`personalAttempt.count:${args.where.userId}`);
        return options.attempts ?? 0;
      },
    },
    resume: {
      findMany: async (args: { where: { userId: string } }) => {
        calls.push(`resume.findMany:${args.where.userId}`);
        return options.resumes ?? [];
      },
    },
    user: {
      delete: async (args: { where: { id: string } }) => {
        calls.push(`user.delete:${args.where.id}`);
        deleted.push(args.where.id);
        return { id: args.where.id };
      },
    },
  };
  return { db: db as unknown as PrismaClient, calls, deleted };
}

describe("deleteAccountRecords", () => {
  it("reads the resume files before deleting the user, then returns them", async () => {
    const { db, calls, deleted } = fakePrisma({
      resumes: [
        { id: "r1", sourceFilename: "r1.pdf", variants: [{ id: "v1" }, { id: "v2" }] },
        { id: "r2", sourceFilename: null, variants: [] },
      ],
    });

    const files = await deleteAccountRecords(db, "u1");

    expect(calls).toEqual(["personalAttempt.count:u1", "resume.findMany:u1", "user.delete:u1"]);
    expect(deleted).toEqual(["u1"]);
    expect(files).toEqual([
      { resumeId: "r1", sourceFilename: "r1.pdf", variantIds: ["v1", "v2"] },
      { resumeId: "r2", sourceFilename: null, variantIds: [] },
    ]);
  });

  it("returns no files for an account without resumes", async () => {
    const { db, deleted } = fakePrisma();

    expect(await deleteAccountRecords(db, "u1")).toEqual([]);
    expect(deleted).toEqual(["u1"]);
  });

  it("refuses with 409 and deletes nothing when a personal attempt ledger exists", async () => {
    const { db, deleted } = fakePrisma({ attempts: 1 });

    const error = await deleteAccountRecords(db, "u1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect(deleted).toEqual([]);
  });
});

describe("confirmsAccountEmail", () => {
  it("accepts the sign-in email regardless of case and surrounding spaces", () => {
    expect(confirmsAccountEmail("ada@example.com", "ada@example.com")).toBe(true);
    expect(confirmsAccountEmail("  Ada@Example.COM ", "ada@example.com")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(confirmsAccountEmail("", "ada@example.com")).toBe(false);
    expect(confirmsAccountEmail("ada@example.co", "ada@example.com")).toBe(false);
    expect(confirmsAccountEmail("delete", "ada@example.com")).toBe(false);
    expect(confirmsAccountEmail("ada @example.com", "ada@example.com")).toBe(false);
  });
});
