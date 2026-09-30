import "reflect-metadata";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "@/env";
import { objectValue } from "../runtime";
import { batchFixture } from "./fakes";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
let root: string;
let f: ReturnType<typeof batchFixture>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jobpilot-batch-tests-"));
  Object.assign(env, { PERSONAL_MODE: true, JOBPILOT_PERSONAL_ROOT: root });
  f = batchFixture();
  await writeFile(
    path.join(root, "runtime.json"),
    JSON.stringify({ account: { userId: f.userId } }),
  );
});
afterEach(async () => {
  Object.assign(env, original);
  await rm(root, { recursive: true, force: true });
});
const input = () => ({ campaignId: f.campaignId, recordIds: f.records.map((record) => record.id) });

describe("shared batch lifecycle retains per-job preparation", () => {
  test("creates one immutable analysis and shared source question, reuses retries and never adopts answers", async () => {
    const batch = await f.service.create(f.userId, input());
    const repeated = await f.service.create(f.userId, input());
    expect(repeated.id).toBe(batch.id);
    expect(f.questions).toHaveLength(1);
    expect(f.runs).toHaveLength(1);
    expect(
      f.records.every(
        (record) =>
          objectValue(objectValue(record.details).tailoringBatch).analysisHash ===
          batch.analysisHash,
      ),
    ).toBe(true);
    f.questions[0]!.answer = "I have 20 years of C++ experience";
    f.questions[0]!.status = "answered";
    const answered = await f.service.get(f.userId, batch.id);
    expect(answered.sourceQuestion?.requiresSourceAcceptance).toBe(true);
    expect(answered.analysis.missingTerms.map((item) => item.term)).toEqual(["c++"]);
    expect(f.data.summary).toBe("PE VC AI");
    expect(f.calls).toHaveLength(0);
  });

  test("preserves completed variants across resumption and isolates one member failure", async () => {
    const batch = await f.service.create(f.userId, input());
    const complete = f.records.find((record) => record.id === batch.members[0]!.recordId)!;
    f.markComplete(complete);
    const completeDetails = structuredClone(complete.details);
    f.fail.add(batch.members[1]!.recordId);
    const first = await f.service.advance(f.userId, batch.id, {
      expectedAnalysisHash: batch.analysisHash,
      retryBlocked: false,
    });
    expect(
      first.members.find((member) => member.recordId === batch.members[1]!.recordId)?.status,
    ).toBe("blocked");
    const second = await f.service.advance(f.userId, batch.id, {
      expectedAnalysisHash: batch.analysisHash,
      retryBlocked: false,
    });
    expect(
      second.members.find((member) => member.recordId === batch.members[2]!.recordId)?.phase,
    ).toBe("claim_review");
    expect(f.calls).toEqual([batch.members[1]!.recordId, batch.members[2]!.recordId]);
    expect(complete.details).toEqual(completeDetails);
  });

  test("source revision or changed posting invalidates analysis before another worker call", async () => {
    const batch = await f.service.create(f.userId, input());
    f.data.summary += " C++";
    const changed = await f.service.get(f.userId, batch.id);
    expect(changed.status).toBe("stale");
    await expect(
      f.service.advance(f.userId, batch.id, {
        expectedAnalysisHash: batch.analysisHash,
        retryBlocked: false,
      }),
    ).rejects.toThrow("changed");
    expect(f.calls).toHaveLength(0);
  });

  test("wrong expected hashes and concurrent claims do not start preparation", async () => {
    const batch = await f.service.create(f.userId, input());
    await expect(
      f.service.advance(f.userId, batch.id, {
        expectedAnalysisHash: "f".repeat(64),
        retryBlocked: false,
      }),
    ).rejects.toThrow("changed");
    const row = f.runs[0]!;
    row.details = {
      ...objectValue(row.details),
      claim: "other",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as never;
    await expect(
      f.service.advance(f.userId, batch.id, {
        expectedAnalysisHash: batch.analysisHash,
        retryBlocked: false,
      }),
    ).rejects.toThrow("Another worker");
    expect(f.calls).toHaveLength(0);
  });

  test("detects a modified shared artifact and foreign runtime users", async () => {
    const batch = await f.service.create(f.userId, input());
    await expect(f.service.get(crypto.randomUUID(), batch.id)).rejects.toThrow("cannot access");
    await writeFile(String(objectValue(f.runs[0]!.details).analysisPath), "{}");
    await expect(f.service.get(f.userId, batch.id)).rejects.toThrow("integrity");
  });
});
