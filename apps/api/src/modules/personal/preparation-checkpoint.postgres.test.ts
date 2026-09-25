import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersonalCampaignService } from "./campaign.service";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalPreparationService } from "./preparation.service";
import { PersonalPreviewService } from "./preview.service";
import { jsonValue, objectValue, savePrivate } from "./runtime";
import type { runCodexTailoring } from "./tailoring/codex";
import { sourceFixture } from "./tailoring/fakes";
import { PersonalTailoringService } from "./tailoring.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

class SyntheticTailoring extends PersonalTailoringService {
  protected override async generate(
    input: Parameters<typeof runCodexTailoring>[0],
    options: Parameters<typeof runCodexTailoring>[1],
  ) {
    const fact = input.facts.find((item) => item.editable)!;
    const proposal = {
      version: 1 as const,
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
    const artifactPath = join(options.runtimeDir, "synthetic-proposals", `${input.inputHash}.json`);
    await savePrivate(artifactPath, proposal);
    return {
      status: "proposed" as const,
      proposal,
      artifactPath,
      providerMode: "chatgpt_subscription" as const,
    };
  }
}

async function failureFrom(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the synthetic checkpoint failure");
}

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("preparation checkpoint PostgreSQL compensation", () => {
  let db: PersonalTestDatabase;
  let identity = 900;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30_000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function fixture() {
    const f = await personalFixture(db, "offline", 3);
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({
        account: { userId: f.user.id },
        tailoringProvider: { provider: "openai", allowApplicantData: true },
      }),
      { mode: 0o600 },
    );
    const data = sourceFixture().data;
    const personal = {
      settings: async () => f.settings,
      resumeData: async () => ({ data, evidence: f.resume, resume: { id: f.resume.resumeId } }),
    } as unknown as PersonalService;
    const campaigns = new PersonalCampaignService(db.prisma, personal, db.service);
    const campaign = await campaigns.create(f.user.id, {
      name: "Synthetic checkpoint compensation",
      mode: "offline",
      sources: { boardTokens: ["synthetic"] },
      tracks: ["mba_internship"],
      fitThreshold: 0,
      dailyCap: 3,
      maxApplications: 10,
      timezone: "America/New_York",
    });
    const active = await campaigns.launch(f.user.id, campaign.id, true);
    async function record() {
      const r = await f.record(String(++identity));
      const { preview: _preview, ...details } = objectValue(r.record.details);
      return db.prisma.personalRecord.update({
        where: { id: r.record.id },
        data: { details: jsonValue(details) },
      });
    }
    const row = await record();
    const tailoring = new SyntheticTailoring(db.prisma, personal);
    const service = new PersonalPreparationService(
      db.prisma,
      personal,
      tailoring,
      new PersonalPreviewService(db.prisma, personal),
    );
    const saved = () => db.prisma.personalRecord.findUniqueOrThrow({ where: { id: row.id } });
    function beforeFinalContext(work: () => Promise<void>) {
      let calls = 0;
      personal.settings = async () => {
        if (++calls === 4) await work();
        return f.settings;
      };
    }
    async function expectRetainedProposal() {
      const details = objectValue((await saved()).details);
      const proposed = objectValue(details.tailoring);
      expect(proposed.status).toBe("proposed");
      expect(JSON.parse(await readFile(String(proposed.artifactPath), "utf8"))).toEqual(
        proposed.proposal,
      );
      expect(details.preview).toBeUndefined();
      return details;
    }
    async function expectReleasedSlot() {
      const other = await record();
      const result = await service.advance(f.user.id, other.id, active.id);
      expect(result.status).toBe("pending");
      expect(result.phase).toBe("claim_review");
    }
    return {
      ...f,
      active,
      row,
      service,
      saved,
      beforeFinalContext,
      expectRetainedProposal,
      expectReleasedSlot,
    };
  }

  test("final context failure releases the user slot and retains completed proposal evidence", async () => {
    const f = await fixture();
    f.beforeFinalContext(async () => {
      throw new Error("Synthetic final context read failure");
    });
    const error = await failureFrom(f.service.advance(f.user.id, f.row.id, f.active.id));
    expect(String(error)).toContain("Synthetic final context read failure");
    const details = await f.expectRetainedProposal();
    expect(objectValue(details.preparation)).toMatchObject({
      status: "blocked",
      phase: "propose",
      leaseExpiresAt: null,
      attempts: 1,
    });
    expect(String(objectValue(details.preparation).reason)).toContain("checkpoint interrupted");
    await f.expectReleasedSlot();
  });

  test("checkpoint file failure releases the slot without deleting the durable proposal", async () => {
    const f = await fixture();
    const directory = join(db.root, "storage", f.user.id);
    await mkdir(directory, { recursive: true });
    const obstruction = join(directory, "preparation");
    await writeFile(obstruction, "Synthetic checkpoint obstruction", { mode: 0o600 });
    const error = await failureFrom(f.service.advance(f.user.id, f.row.id, f.active.id));
    expect(String(error)).toContain("EEXIST");
    const details = await f.expectRetainedProposal();
    expect(objectValue(details.preparation)).toMatchObject({
      status: "blocked",
      leaseExpiresAt: null,
    });
    expect(await readFile(obstruction, "utf8")).toBe("Synthetic checkpoint obstruction");
    expect(
      await db.prisma.personalRecord.count({
        where: {
          userId: f.user.id,
          details: { path: ["preparation", "status"], equals: "running" },
        },
      }),
    ).toBe(0);
  });

  test("compensation preserves unrelated edits made during a failing context read", async () => {
    const f = await fixture();
    f.beforeFinalContext(async () => {
      const current = await f.saved();
      await db.prisma.personalRecord.update({
        where: { id: current.id },
        data: {
          state: "eligible",
          details: jsonValue({ ...objectValue(current.details), concurrentEdit: "retained" }),
        },
      });
      throw new Error("Synthetic context interrupted after concurrent edit");
    });
    await failureFrom(f.service.advance(f.user.id, f.row.id, f.active.id));
    const details = await f.expectRetainedProposal();
    expect(details.concurrentEdit).toBe("retained");
    expect((await f.saved()).state).toBe("eligible");
    expect(objectValue(details.preparation).status).toBe("blocked");
    await f.expectReleasedSlot();
  });

  test("failed compare-and-swap retains its checkpoint file and newer record edits", async () => {
    const f = await fixture();
    f.beforeFinalContext(async () => {
      const current = await f.saved();
      await db.prisma.personalRecord.update({
        where: { id: current.id },
        data: {
          updatedAt: new Date(current.updatedAt.getTime() + 1000),
          details: jsonValue({
            ...objectValue(current.details),
            concurrentEdit: "checkpoint-race",
          }),
        },
      });
    });
    const error = await failureFrom(f.service.advance(f.user.id, f.row.id, f.active.id));
    expect(String(error)).toContain("checkpoint changed");
    const details = await f.expectRetainedProposal();
    const preparation = objectValue(details.preparation);
    expect(preparation.status).toBe("blocked");
    expect(details.concurrentEdit).toBe("checkpoint-race");
    const artifact = JSON.parse(
      await readFile(
        join(db.root, "storage", f.user.id, "preparation", `${preparation.claimId}.json`),
        "utf8",
      ),
    );
    expect(artifact.status).toBe("pending");
    expect(artifact.phase).toBe("claim_review");
    await f.expectReleasedSlot();
  });

  test("a replacement preparation owner remains untouched by an older claim's cleanup", async () => {
    const f = await fixture();
    const replacement = crypto.randomUUID();
    let expected: unknown;
    f.beforeFinalContext(async () => {
      const current = await f.saved();
      const details = objectValue(current.details);
      expected = { ...objectValue(details.preparation), claimId: replacement, newerOwner: true };
      await db.prisma.personalRecord.update({
        where: { id: current.id },
        data: { details: jsonValue({ ...details, preparation: expected }) },
      });
      throw new Error("Synthetic checkpoint lost its original owner");
    });
    await failureFrom(f.service.advance(f.user.id, f.row.id, f.active.id));
    const details = await f.expectRetainedProposal();
    expect(details.preparation).toEqual(expected);
    expect(objectValue(details.preparation).status).toBe("running");
    expect(objectValue(details.preparation).claimId).toBe(replacement);
  });
});
