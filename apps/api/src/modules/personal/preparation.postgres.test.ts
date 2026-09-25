import { readFile, writeFile } from "node:fs/promises";
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
import { PersonalReassessmentService } from "./reassessment.service";
import { jsonValue, objectValue, sha256 } from "./runtime";
import type { runCodexClaimReview, runCodexRenderReview } from "./tailoring/codex-review";
import { sourceFixture, supportedReview } from "./tailoring/fakes";
import type { TailoringInput, TailoringProposal } from "./tailoring/proposal";
import { PersonalTailoringService } from "./tailoring.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
class SyntheticTailoring extends PersonalTailoringService {
  calls = 0;
  beforeGenerate?: () => Promise<void>;
  protected override async generate(input: TailoringInput) {
    this.calls++;
    await this.beforeGenerate?.();
    return {
      status: "proposed" as const,
      proposal: proposal(input),
      artifactPath: "/synthetic/proposal.json",
      providerMode: "chatgpt_subscription" as const,
    };
  }
}
class SyntheticPreparation extends PersonalPreparationService {
  claimCalls = 0;
  renderCalls = 0;
  claimHeld = false;
  renderHeld = false;
  beforeClaim?: () => Promise<void>;
  beforeRenderReview?: () => Promise<void>;
  renderedHash?: string;
  protected override claimReview: typeof runCodexClaimReview = async (input, proposed) => {
    this.claimCalls++;
    await this.beforeClaim?.();
    if (this.claimHeld)
      return {
        status: "blocked",
        reason: "Synthetic independent reviewer found unsupported claims",
        diagnostic: { phase: "review_validation", code: "review_validation_failed" },
        providerMode: "chatgpt_subscription",
      };
    return {
      status: "reviewed",
      review: supportedReview(input, proposed),
      artifactPath: "/synthetic/claim.json",
      providerMode: "chatgpt_subscription",
    };
  };
  protected override render = async (
    bytes: Uint8Array,
    options: Parameters<PersonalPreparationService["render"]>[1],
  ) => {
    this.renderCalls++;
    expect(sha256(bytes)).toBe(options.pdfHash);
    this.renderedHash = options.pdfHash;
    const png = Buffer.from("synthetic rendered page");
    return {
      pdfHash: options.pdfHash,
      maxPages: options.maxPages,
      pageCount: 1,
      textContext: "Synthetic rendered page text",
      pages: [{ pageNumber: 1, png, sha256: sha256(png) }],
    };
  };
  protected override renderReview: typeof runCodexRenderReview = async (input) => {
    await this.beforeRenderReview?.();
    const decision = this.renderHeld ? ("hold" as const) : ("pass" as const);
    return {
      status: "reviewed",
      artifactPath: "/synthetic/render.json",
      providerMode: "chatgpt_subscription",
      review: {
        pdfHash: input.pdfHash,
        maxPages: input.maxPages,
        decision,
        reviewer: "independent-synthetic-renderer",
        reviewedAt: new Date().toISOString(),
        pages: input.pages.map((page) => ({
          pageNumber: page.pageNumber,
          imageHash: page.sha256,
          decision,
          findings: ["Synthetic layout result"],
        })),
      },
    };
  };
}

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal preparation PostgreSQL lifecycle", () => {
  let db: PersonalTestDatabase;
  let identity = 100;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function fixture() {
    const f = await personalFixture(db, "offline", 3);
    const data = sourceFixture().data;
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({
        account: { userId: f.user.id },
        tailoringProvider: { provider: "openai", allowApplicantData: true },
      }),
      { mode: 0o600 },
    );
    const personal = {
      settings: async () => f.settings,
      resumeData: async () => ({ data, evidence: f.resume, resume: { id: f.resume.resumeId } }),
      record: async (_user: string, id: string) =>
        db.prisma.personalRecord.findUniqueOrThrow({ where: { id } }),
      pdf: async (_user: string, id: string) => {
        const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id } });
        const document = objectValue(objectValue(row.details).document);
        return new Response(await readFile(String(document.path)));
      },
    } as unknown as PersonalService;
    const campaigns = new PersonalCampaignService(db.prisma, personal, db.service);
    async function campaign() {
      const created = await campaigns.create(f.user.id, {
        name: "Synthetic preparation",
        mode: "offline",
        sources: { boardTokens: ["synthetic"] },
        tracks: ["mba_internship"],
        fitThreshold: 0,
        dailyCap: 3,
        maxApplications: 10,
        timezone: "America/New_York",
      });
      return campaigns.launch(f.user.id, created.id, true);
    }
    async function record() {
      const r = await f.record(String(++identity));
      const { preview: _preview, ...details } = objectValue(r.record.details);
      return db.prisma.personalRecord.update({
        where: { id: r.record.id },
        data: { details: jsonValue(details) },
      });
    }
    const active = await campaign();
    const row = await record();
    const tailoring = new SyntheticTailoring(db.prisma, personal);
    const preview = new PersonalPreviewService(db.prisma, personal);
    const make = () => new SyntheticPreparation(db.prisma, personal, tailoring, preview);
    const saved = async () => db.prisma.personalRecord.findUniqueOrThrow({ where: { id: row.id } });
    async function throughPreview() {
      for (let phase = 0; phase < 3; phase++) {
        const result = await make().advance(f.user.id, row.id, active.id);
        expect(result.status).toBe("pending");
      }
    }
    return {
      ...f,
      active,
      row,
      campaign,
      campaigns,
      personal,
      record,
      tailoring,
      make,
      saved,
      throughPreview,
    };
  }

  test("independent claim hold retains proposal without generating or approving a PDF", async () => {
    const f = await fixture();
    expect((await f.make().advance(f.user.id, f.row.id, f.active.id)).phase).toBe("claim_review");
    const resumed = f.make();
    resumed.claimHeld = true;
    expect((await resumed.advance(f.user.id, f.row.id, f.active.id)).status).toBe("blocked");
    const details = objectValue((await f.saved()).details);
    expect(objectValue(details.tailoring).status).toBe("proposed");
    expect(details.preview).toBeUndefined();
    expect(f.tailoring.calls).toBe(1);
    expect(resumed.claimCalls).toBe(1);
    expect(resumed.renderCalls).toBe(0);
  });

  test("new service instances resume persisted stages and bind review to the rendered PDF", async () => {
    const f = await fixture();
    await f.throughPreview();
    const draft = objectValue(objectValue((await f.saved()).details).preview);
    expect(draft.renderReviewed).toBe(false);
    const resumed = f.make();
    expect((await resumed.advance(f.user.id, f.row.id, f.active.id)).status).toBe("ready");
    const details = objectValue((await f.saved()).details);
    expect(resumed.renderedHash).toBe(String(draft.pdfHash));
    expect(objectValue(details.renderReview).pdfHash).toBe(draft.pdfHash);
    expect(objectValue(details.preview).renderReviewed).toBe(true);
    expect(f.tailoring.calls).toBe(1);
    expect(resumed.claimCalls).toBe(0);
  });

  test("one user slot excludes simultaneous preparation from another campaign", async () => {
    const f = await fixture();
    const otherCampaign = await f.campaign();
    const other = await f.record();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.tailoring.beforeGenerate = async () => {
      started.resolve();
      await release.promise;
    };
    const first = f.make().advance(f.user.id, f.row.id, f.active.id);
    try {
      await started.promise;
      const busy = f.make().advance(f.user.id, other.id, otherCampaign.id);
      await expect(busy).rejects.toThrow("user slot");
      await expect(busy).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        headers: { "retry-after": "60" },
      });
      expect(f.tailoring.calls).toBe(1);
    } finally {
      release.resolve();
      await first;
    }
  });

  test("stopped and newly out-of-scope campaigns start no generation", async () => {
    const f = await fixture();
    await f.campaigns.stop(f.user.id, f.active.id);
    await expect(f.make().advance(f.user.id, f.row.id, f.active.id)).rejects.toThrow(
      "active campaign",
    );
    const other = await f.campaign();
    const campaign = await db.prisma.campaign.findUniqueOrThrow({
      where: { campaignId: other.id },
    });
    await db.prisma.campaign.update({
      where: { campaignId: other.id },
      data: {
        config: jsonValue({
          ...objectValue(campaign.config),
          personal: {
            ...objectValue(objectValue(campaign.config).personal),
            sources: { boardTokens: ["different"] },
          },
        }),
      },
    });
    await expect(f.make().advance(f.user.id, f.row.id, other.id)).rejects.toThrow(
      "Source is outside",
    );
    expect(f.tailoring.calls).toBe(0);
  });

  test("an already cancelled request creates no generation or ready document", async () => {
    const f = await fixture();
    const result = await f.make().advance(f.user.id, f.row.id, f.active.id, AbortSignal.abort());
    expect(result.status).toBe("blocked");
    expect(f.tailoring.calls).toBe(0);
    expect(objectValue((await f.saved()).details).preview).toBeUndefined();
  });

  test("stop during independent claim review prevents installing the review", async () => {
    const f = await fixture();
    await f.make().advance(f.user.id, f.row.id, f.active.id);
    const resumed = f.make();
    resumed.beforeClaim = async () => {
      await f.campaigns.stop(f.user.id, f.active.id);
    };
    expect((await resumed.advance(f.user.id, f.row.id, f.active.id)).status).toBe("blocked");
    const details = objectValue((await f.saved()).details);
    expect(objectValue(details.tailoring).status).toBe("proposed");
    expect(details.preview).toBeUndefined();
  });

  test("render hold never automatically marks a draft ready", async () => {
    const f = await fixture();
    await f.throughPreview();
    const resumed = f.make();
    resumed.renderHeld = true;
    expect((await resumed.advance(f.user.id, f.row.id, f.active.id)).status).toBe("blocked");
    expect(objectValue(objectValue((await f.saved()).details).preview)).toMatchObject({
      readiness: "draft",
      renderReviewed: false,
    });
  });

  test("a PDF replaced during visual review cannot inherit its predecessor's approval", async () => {
    const f = await fixture();
    await f.throughPreview();
    const before = objectValue(objectValue((await f.saved()).details).preview).pdfHash;
    const resumed = f.make();
    resumed.beforeRenderReview = async () => {
      const current = await f.saved();
      const details = objectValue(current.details);
      await db.prisma.personalRecord.update({
        where: { id: current.id },
        data: {
          details: jsonValue({
            ...details,
            preview: { ...objectValue(details.preview), pdfHash: "e".repeat(64) },
          }),
        },
      });
    };
    expect((await resumed.advance(f.user.id, f.row.id, f.active.id)).status).toBe("blocked");
    expect(resumed.renderedHash).toBe(String(before));
    expect(objectValue(objectValue((await f.saved()).details).preview).renderReviewed).toBe(false);
  });

  test("unsupported provider setup creates a hold with no generation", async () => {
    const f = await fixture();
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({ account: { userId: f.user.id } }),
    );
    expect((await f.make().advance(f.user.id, f.row.id, f.active.id)).status).toBe("blocked");
    expect(f.tailoring.calls).toBe(0);
    expect(objectValue((await f.saved()).details).preview).toBeUndefined();
  });

  test("posting drift holds until eligibility refresh before restarting the proposal", async () => {
    const f = await fixture();
    await f.throughPreview();
    await f.make().advance(f.user.id, f.row.id, f.active.id);
    const current = await f.saved();
    const details = objectValue(current.details);
    const posting = objectValue(details.posting);
    await db.prisma.personalRecord.update({
      where: { id: current.id },
      data: {
        details: jsonValue({
          ...details,
          posting: {
            ...posting,
            descriptionText: `${posting.descriptionText} Additional SQL research responsibilities.`,
          },
        }),
      },
    });
    await expect(f.make().advance(f.user.id, f.row.id, f.active.id)).rejects.toThrow(
      "Eligibility needs refresh",
    );
    expect(f.tailoring.calls).toBe(1);
    const reassessment = new PersonalReassessmentService(db.prisma, f.personal);
    expect(await reassessment.refreshStale(f.user.id, [f.row.id])).toEqual({
      evaluated: 1,
      skipped: 0,
    });
    const result = await f.make().advance(f.user.id, f.row.id, f.active.id);
    expect(result.status).toBe("pending");
    expect(result.phase).toBe("claim_review");
    expect(f.tailoring.calls).toBe(2);
  });

  test("changed attachment evidence regenerates a draft and requires new render review", async () => {
    const f = await fixture();
    await f.throughPreview();
    await f.make().advance(f.user.id, f.row.id, f.active.id);
    const current = await f.saved();
    const details = objectValue(current.details);
    const inventory = objectValue(details.attachmentRequirements);
    await db.prisma.personalRecord.update({
      where: { id: current.id },
      data: {
        details: jsonValue({
          ...details,
          attachmentRequirements: {
            ...inventory,
            source: {
              ...objectValue(inventory.source),
              capturedAt: new Date(Date.now() + 1000).toISOString(),
            },
          },
        }),
      },
    });
    const result = await f.make().advance(f.user.id, f.row.id, f.active.id);
    expect(result.status).toBe("pending");
    expect(result.phase).toBe("render_review");
    expect(objectValue(objectValue((await f.saved()).details).preview).renderReviewed).toBe(false);
    expect(f.tailoring.calls).toBe(1);
  });
});
