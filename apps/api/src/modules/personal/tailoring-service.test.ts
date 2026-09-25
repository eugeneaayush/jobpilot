import "reflect-metadata";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { env } from "@/env";
import type { PersonalRecord, PrismaClient } from "@/generated/prisma/client";
import type { PersonalService } from "./personal.service";
import { PersonalPreviewService } from "./preview.service";
import { objectValue } from "./runtime";
import type { runCodexTailoring } from "./tailoring/codex";
import { sourceFixture, supportedReview } from "./tailoring/fakes";
import {
  buildTailoringInput,
  type TailoringInput,
  type TailoringProposal,
} from "./tailoring/proposal";
import { PersonalTailoringService } from "./tailoring.service";
import { afterEach, expect, test } from "bun:test";

const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
const originalProcessRoot = process.env.JOBPILOT_PERSONAL_ROOT;
const roots: string[] = [];
afterEach(async () => {
  Object.assign(env, original);
  if (originalProcessRoot === undefined) delete process.env.JOBPILOT_PERSONAL_ROOT;
  else process.env.JOBPILOT_PERSONAL_ROOT = originalProcessRoot;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
class SyntheticTailoring extends PersonalTailoringService {
  calls = 0;
  generateWork: (input: TailoringInput) => ReturnType<typeof runCodexTailoring> = async (
    input,
  ) => ({
    status: "proposed",
    proposal: proposal(input),
    artifactPath: "/synthetic/proposal.json",
    providerMode: "chatgpt_subscription",
  });
  protected override generate(input: TailoringInput) {
    this.calls++;
    return this.generateWork(input);
  }
}
function proposal(input: TailoringInput): TailoringProposal {
  const fact = input.facts.find((item) => item.editable)!;
  return {
    version: 1,
    inputHash: input.inputHash,
    rewrites: [
      {
        id: "rewrite-1",
        targetFactId: fact.id,
        text: "Developed SQL reporting for a $12M portfolio",
        citations: [{ factId: fact.id, quoteSha256: fact.quoteSha256 }],
      },
    ],
    essayClaims: [],
  };
}
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-tailoring-service-"));
  roots.push(root);
  env.PERSONAL_MODE = true;
  env.JOBPILOT_PERSONAL_ROOT = root;
  process.env.JOBPILOT_PERSONAL_ROOT = root;
  const owner = crypto.randomUUID();
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({
      account: { userId: owner },
      tailoringProvider: { provider: "openai", allowApplicantData: true },
    }),
    { mode: 0o600 },
  );
  const source = sourceFixture();
  const row: PersonalRecord = {
    id: crypto.randomUUID(),
    userId: owner,
    campaignId: null,
    jobId: null,
    identity: "greenhouse:fixture:1",
    title: "MBA Intern",
    company: "Fixture",
    url: "https://example.test/job",
    requisitionId: "1",
    state: "discovered",
    track: "mba_internship",
    createdAt: new Date(0),
    updatedAt: new Date(1),
    details: {
      posting: {
        descriptionText: "MBA students perform investment research and SQL reporting.",
        contentHash: "b".repeat(64),
      },
      eligibility: { decision: "unknown", reasons: ["Missing source evidence"] },
      missingAnswers: ["Required answer"],
      preview: { readiness: "ready" },
      renderReview: { inspected: true },
    },
  };
  let resumeReads = 0;
  const mutate = (change: Partial<PersonalRecord>) =>
    Object.assign(row, change, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
  let beforeUpdate: (() => void) | undefined;
  const prisma = {
    personalRecord: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === row.id && where.userId === owner ? structuredClone(row) : null,
      findUniqueOrThrow: async () => structuredClone(row),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          userId: string;
          updatedAt: Date;
          state?: { notIn: string[] };
          details?: { equals: unknown };
        };
        data: Partial<PersonalRecord>;
      }) => {
        const callback = beforeUpdate;
        beforeUpdate = undefined;
        callback?.();
        if (
          where.id !== row.id ||
          where.userId !== owner ||
          where.updatedAt.getTime() !== row.updatedAt.getTime() ||
          (where.details && JSON.stringify(where.details.equals) !== JSON.stringify(row.details)) ||
          where.state?.notIn.includes(row.state)
        )
          return { count: 0 };
        mutate(data);
        return { count: 1 };
      },
    },
    personalAttempt: { findMany: async () => [] },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  const personal = {
    resumeData: async (userId: string) => {
      expect(userId).toBe(owner);
      resumeReads++;
      return {
        data: source.data,
        evidence: {
          id: crypto.randomUUID(),
          sourceHash: source.input.sourceDigest,
          details: { conflicts: [] },
        },
        resume: { id: crypto.randomUUID() },
      };
    },
    settings: async () => personalSettingsSchema.parse({}),
  };
  const service = new SyntheticTailoring(
    prisma as unknown as PrismaClient,
    personal as unknown as PersonalService,
  );
  const input = () =>
    buildTailoringInput(source.data, {
      sourceDigest: source.input.sourceDigest,
      maxPages: 1,
      job: {
        identity: row.identity,
        title: row.title,
        company: row.company,
        description: String(objectValue(objectValue(row.details).posting).descriptionText),
        postingContentHash: String(objectValue(objectValue(row.details).posting).contentHash),
      },
    });
  const install = () => {
    const packet = input();
    const output = proposal(packet);
    mutate({
      details: {
        ...objectValue(row.details),
        tailoring: { status: "proposed", input: packet, proposal: output },
      } as never,
    });
    return { input: packet, proposal: output, review: supportedReview(packet, output) };
  };
  return {
    row,
    owner,
    source,
    service,
    mutate,
    input,
    install,
    root,
    resumeReads: () => resumeReads,
    beforeUpdate: (work: () => void) => {
      beforeUpdate = work;
    },
    preview: new PersonalPreviewService(
      prisma as unknown as PrismaClient,
      personal as unknown as PersonalService,
    ),
  };
}

test("foreign owner cannot read, propose or review another record's source facts", async () => {
  const f = await harness();
  const foreign = crypto.randomUUID();
  await expect(f.service.get(foreign, f.row.id)).rejects.toThrow("Record not found");
  await expect(f.service.propose(foreign, f.row.id)).rejects.toThrow("Record not found");
  await expect(
    f.service.review(foreign, f.row.id, supportedReview(f.input(), proposal(f.input()))),
  ).rejects.toThrow("Record not found");
  expect(f.resumeReads()).toBe(0);
  expect(f.service.calls).toBe(0);
});

for (const state of ["applying", "submitted", "submission_uncertain"] as const)
  test(`${state} prevents proposal, review and preview mutation`, async () => {
    const f = await harness();
    const installed = f.install();
    f.mutate({ state });
    const before = structuredClone(f.row);
    await expect(f.service.propose(f.owner, f.row.id)).rejects.toThrow("immutable");
    await expect(f.service.review(f.owner, f.row.id, installed.review)).rejects.toThrow(
      "immutable",
    );
    await expect(f.preview.preview(f.owner, f.row.id)).rejects.toThrow(
      "active or possibly submitted",
    );
    expect(f.row).toEqual(before);
    expect(f.service.calls).toBe(0);
  });

test("one proposal claim excludes concurrent generators and preserves unrelated edits made during generation", async () => {
  const f = await harness();
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.service.generateWork = async (input) => {
    entered();
    await waiting;
    return {
      status: "proposed",
      proposal: proposal(input),
      artifactPath: "/synthetic/proposal.json",
      providerMode: "chatgpt_subscription",
    };
  };
  const first = f.service.propose(f.owner, f.row.id);
  await started;
  await expect(f.service.propose(f.owner, f.row.id)).rejects.toThrow("already owns");
  f.mutate({ details: { ...objectValue(f.row.details), externalNote: "keep-this-edit" } as never });
  finish();
  expect((await first).status).toBe("proposed");
  expect(objectValue(f.row.details).externalNote).toBe("keep-this-edit");
  expect(f.service.calls).toBe(1);
});

test("late proposal cannot install after source drift, claim replacement or submission transition", async () => {
  for (const change of ["source", "claim", "submission"] as const) {
    const f = await harness();
    f.service.generateWork = async (input) => {
      if (change === "source") f.source.data.experience[0]!.title = "Changed source title";
      if (change === "claim")
        f.mutate({
          details: {
            ...objectValue(f.row.details),
            tailoring: { status: "running", claimId: "replacement" },
          } as never,
        });
      if (change === "submission") f.mutate({ state: "applying" });
      return {
        status: "proposed",
        proposal: proposal(input),
        artifactPath: "/synthetic/proposal.json",
        providerMode: "chatgpt_subscription",
      };
    };
    await expect(f.service.propose(f.owner, f.row.id)).rejects.toThrow();
    expect(objectValue(objectValue(f.row.details).tailoring).status).toBe(
      change === "source" ? "blocked" : "running",
    );
  }
});

test("grounded review preserves eligibility holds and clears old PDF approval; preview still needs render QA", async () => {
  const f = await harness();
  const installed = f.install();
  const eligibility = objectValue(f.row.details).eligibility;
  expect((await f.service.review(f.owner, f.row.id, installed.review)).status).toBe("reviewed");
  expect(objectValue(f.row.details).eligibility).toEqual(eligibility);
  expect(objectValue(f.row.details).missingAnswers).toEqual(["Required answer"]);
  expect(f.row.state).toBe("discovered");
  expect(objectValue(f.row.details).preview).toBeUndefined();
  expect(objectValue(f.row.details).renderReview).toBeUndefined();
  const preview = await f.preview.preview(f.owner, f.row.id);
  expect(preview.preview?.readiness).toBe("draft");
  expect(preview.preview?.renderReviewed).toBe(false);
  expect(preview.eligibility.decision).toBe("unknown");
  const document = objectValue(objectValue(f.row.details).document);
  expect(document.tailoringMode).toBe("reviewed_rewrite");
  expect(document.renderQa).toBe("required");
  expect(objectValue(document.docx)).toMatchObject({ status: "generated", renderQa: "required" });
});

test("stale and unsupported reviews cannot install; stale reviewed source cannot regenerate a PDF", async () => {
  const f = await harness();
  const installed = f.install();
  const invalid = structuredClone(installed.review);
  invalid.proposalHash = "f".repeat(64);
  await expect(f.service.review(f.owner, f.row.id, invalid)).rejects.toThrow("grounded");
  invalid.proposalHash = installed.review.proposalHash;
  invalid.claims[0]!.decision = "unsupported";
  await expect(f.service.review(f.owner, f.row.id, invalid)).rejects.toThrow("not grounded");
  expect(objectValue(objectValue(f.row.details).tailoring).status).toBe("proposed");
  await f.service.review(f.owner, f.row.id, installed.review);
  f.source.data.experience[0]!.bullets[0] = "Changed source bullet";
  await expect(f.preview.preview(f.owner, f.row.id)).rejects.toThrow("stale");
});

test("review compare-and-swap rejects a concurrent record mutation", async () => {
  const f = await harness();
  const installed = f.install();
  f.beforeUpdate(() => {
    const timestamp = f.row.updatedAt;
    f.mutate({ details: { ...objectValue(f.row.details), concurrentNote: "preserve" } as never });
    f.row.updatedAt = timestamp;
  });
  await expect(f.service.review(f.owner, f.row.id, installed.review)).rejects.toThrow(
    "Record changed",
  );
  expect(objectValue(f.row.details).concurrentNote).toBe("preserve");
  expect(objectValue(objectValue(f.row.details).tailoring).status).toBe("proposed");
});

test("same-timestamp competing reservation cannot start a second generator", async () => {
  const f = await harness();
  f.beforeUpdate(() => {
    const timestamp = f.row.updatedAt;
    f.mutate({
      details: {
        ...objectValue(f.row.details),
        tailoring: { status: "running", claimId: "other-worker" },
      } as never,
    });
    f.row.updatedAt = timestamp;
  });
  await expect(f.service.propose(f.owner, f.row.id)).rejects.toThrow(
    "before tailoring reservation",
  );
  expect(f.service.calls).toBe(0);
  expect(objectValue(objectValue(f.row.details).tailoring).claimId).toBe("other-worker");
});

test("pending or failed requested tailoring cannot silently generate an extractive preview", async () => {
  const f = await harness();
  for (const status of ["running", "proposed", "blocked", "timed_out", "cancelled"]) {
    f.mutate({ details: { ...objectValue(f.row.details), tailoring: { status } } as never });
    await expect(f.preview.preview(f.owner, f.row.id)).rejects.toThrow("no extractive fallback");
  }
  expect(objectValue(f.row.details).document).toBeUndefined();
});

test("missing provider approval is durable and cannot silently fall back to extractive preview", async () => {
  const f = await harness();
  await writeFile(join(f.root, "runtime.json"), JSON.stringify({ account: { userId: f.owner } }), {
    mode: 0o600,
  });
  expect((await f.service.propose(f.owner, f.row.id)).status).toBe("blocked");
  expect((await f.service.get(f.owner, f.row.id)).status).toBe("blocked");
  expect(f.service.calls).toBe(0);
  await expect(f.preview.preview(f.owner, f.row.id)).rejects.toThrow("no extractive fallback");
});

test("subscription setup failure remains visible through the public tailoring response", async () => {
  const f = await harness();
  const reason =
    "subscription_setup: Tailoring requires verified ChatGPT subscription authentication. Paid API or usage-based mode is disabled.";
  f.service.generateWork = async () => ({
    status: "blocked",
    reason,
    diagnostic: { phase: "subscription_verification", code: "subscription_setup" },
    providerMode: "api_key",
  });
  expect(await f.service.propose(f.owner, f.row.id)).toMatchObject({ status: "blocked", reason });
  expect(await f.service.get(f.owner, f.row.id)).toMatchObject({ status: "blocked", reason });
  expect(objectValue(objectValue(f.row.details).tailoring).providerMode).toBe("api_key");
  await expect(f.preview.preview(f.owner, f.row.id)).rejects.toThrow("no extractive fallback");
});
