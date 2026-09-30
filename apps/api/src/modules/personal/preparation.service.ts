import path from "node:path";
import { personalPreparationResponseSchema } from "@jobpilot/contracts/personal-preparation";
import { singleton } from "tsyringe";
import { conflict, ErrorCodes, HttpError, notFound } from "@/common/errors";
import { PrismaClient } from "@/generated/prisma/client";
import { postingContentHash } from "./attachments-policy";
import { recordScopeParkReason, schedulerPolicy } from "./campaign-policy";
import { eligibilityFreshness } from "./eligibility-freshness";
import { resumePageLimit } from "./graduate-policy";
import { manifestHash } from "./persistence-policy";
import { PersonalService } from "./personal.service";
import { preparationPreviewHash } from "./preparation-policy";
import { PersonalPreviewService } from "./preview.service";
import {
  jsonValue,
  objectValue,
  personalConfiguration,
  personalRoot,
  savePrivate,
} from "./runtime";
import { runCodexClaimReview, runCodexRenderReview } from "./tailoring/codex-review";
import {
  buildTailoringInput,
  type TailoringInput,
  type TailoringProposal,
  tailoringHash,
} from "./tailoring/proposal";
import { renderReviewPages } from "./tailoring/render-pages";
import { PersonalTailoringService } from "./tailoring.service";

type Phase = "propose" | "claim_review" | "preview" | "render_review" | "complete";

@singleton()
export class PersonalPreparationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
    private readonly tailoring: PersonalTailoringService,
    private readonly preview: PersonalPreviewService,
  ) {}

  protected claimReview = runCodexClaimReview;
  protected renderReview = runCodexRenderReview;
  protected render = renderReviewPages;

  private async context(userId: string, recordId: string, campaignId: string) {
    const [record, campaign, settings, resume] = await Promise.all([
      this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } }),
      this.prisma.campaign.findFirst({ where: { campaignId, userId } }),
      this.personal.settings(userId),
      this.personal.resumeData(userId),
    ]);
    if (!record || !campaign) throw notFound("Preparation record or campaign not found");
    const policy = schedulerPolicy(campaign.config);
    if (campaign.status !== "in_progress" || !policy.enabled || !policy.authorization)
      throw conflict("Preparation requires a current authorized active campaign");
    if (
      policy.authorization.settingsHash !== manifestHash(settings) ||
      policy.authorization.sourceHash !== resume.evidence.sourceHash ||
      policy.authorization.resumeEvidenceId !== resume.evidence.id
    )
      throw conflict("Campaign facts changed; launch with the current facts");
    const freshness = eligibilityFreshness(record, { settings, evidence: resume.evidence });
    if (freshness.status !== "current") throw conflict(freshness.reason!);
    const reason = recordScopeParkReason(record, policy);
    if (reason) throw conflict(reason);
    if (!["discovered", "eligible", "prepared"].includes(record.state))
      throw conflict("Preparation cannot change blocked, active or possibly submitted records");
    const details = objectValue(record.details);
    if (objectValue(details.eligibility).decision === "ineligible")
      throw conflict("Ineligible records cannot be prepared");
    const fingerprint = tailoringHash({
      posting: details.posting,
      evidence: resume.evidence.sourceHash,
      data: resume.data,
      settings,
      runId: policy.authorization.runId,
    });
    const input = buildTailoringInput(resume.data, {
      sourceDigest: resume.evidence.sourceHash,
      maxPages: resumePageLimit(record),
      job: {
        identity: record.identity,
        title: record.title,
        company: record.company,
        description: String(objectValue(details.posting).descriptionText ?? ""),
        postingContentHash: postingContentHash(record),
      },
    });
    return {
      record,
      details,
      fingerprint,
      policy,
      inputHash: input.inputHash,
      previewHash: preparationPreviewHash(record, settings, resume.evidence, resume.data),
    };
  }

  private phase(details: Record<string, unknown>, inputHash: string, previewHash: string): Phase {
    const tailoring = objectValue(details.tailoring);
    if (objectValue(tailoring.input).inputHash !== inputHash) return "propose";
    if (tailoring.status !== "reviewed")
      return tailoring.status === "proposed" ? "claim_review" : "propose";
    const preview = objectValue(details.preview);
    if (!preview.pdfHash || preview.preparationContextHash !== previewHash) return "preview";
    if (preview.renderReviewed !== true) return "render_review";
    return "complete";
  }

  private async releaseInterruptedClaim(userId: string, recordId: string, claimId: string) {
    const finishedAt = new Date();
    const interrupted = JSON.stringify({
      status: "blocked",
      reason: "Preparation checkpoint interrupted; inspect retained phase evidence before retry",
      finishedAt: finishedAt.toISOString(),
      leaseExpiresAt: null,
      nextEligibleAt: new Date(finishedAt.getTime() + 3_600_000).toISOString(),
    });
    // Merge only this still-running claim; a concurrent edit or replacement owner must survive.
    await this.prisma.$executeRaw`
      UPDATE personal_records
      SET details = jsonb_set(details, '{preparation}', (details->'preparation') || ${interrupted}::jsonb),
          updated_at = ${finishedAt}
      WHERE id = ${recordId} AND user_id = ${userId}
        AND details #>> '{preparation,claimId}' = ${claimId}
        AND details #>> '{preparation,status}' = 'running'
    `;
  }

  async advance(userId: string, recordId: string, campaignId: string, signal?: AbortSignal) {
    const context = await this.context(userId, recordId, campaignId);
    const phase = this.phase(context.details, context.inputHash, context.previewHash);
    const previous = objectValue(context.details.preparation);
    if (phase === "complete")
      return personalPreparationResponseSchema.parse({
        phase,
        status: objectValue(context.details.preview).readiness === "ready" ? "ready" : "blocked",
        reason:
          objectValue(context.details.preview).readiness === "ready"
            ? null
            : "Required answers, attachments or source conflicts remain unresolved",
        nextEligibleAt: null,
        recordUpdatedAt: context.record.updatedAt,
      });
    const same = previous.fingerprint === context.fingerprint && previous.phase === phase;
    if (same && Number(previous.attempts) >= 3)
      return personalPreparationResponseSchema.parse({
        status: "blocked",
        phase,
        reason: "Preparation retry limit reached; inspect the retained phase evidence",
        nextEligibleAt: null,
        recordUpdatedAt: context.record.updatedAt,
      });
    if (same && Date.parse(String(previous.nextEligibleAt)) > Date.now())
      return personalPreparationResponseSchema.parse({
        status: "pending",
        phase,
        reason: previous.reason ?? null,
        nextEligibleAt: previous.nextEligibleAt,
        recordUpdatedAt: context.record.updatedAt,
      });
    const claimId = crypto.randomUUID();
    const running = {
      status: "running",
      phase,
      claimId,
      campaignId,
      fingerprint: context.fingerprint,
      attempts: same ? Number(previous.attempts ?? 0) + 1 : 1,
      leaseExpiresAt: new Date(Date.now() + 16 * 60_000).toISOString(),
      startedAt: new Date().toISOString(),
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const active = await tx.personalRecord.findFirst({
        where: {
          userId,
          AND: [
            { details: { path: ["preparation", "status"], equals: "running" } },
            { details: { path: ["preparation", "leaseExpiresAt"], gt: new Date().toISOString() } },
          ],
        },
      });
      if (active)
        throw new HttpError(
          ErrorCodes.CONFLICT,
          "One preparation worker already owns this user slot",
          409,
          undefined,
          { "retry-after": "60" },
        );
      const claimed = await tx.personalRecord.updateMany({
        where: { id: recordId, userId, updatedAt: context.record.updatedAt },
        data: { details: jsonValue({ ...context.details, preparation: running }) },
      });
      if (claimed.count !== 1) throw conflict("Record changed before preparation claim");
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let checking = false;
    const verify = async () => {
      const fresh = await this.context(userId, recordId, campaignId);
      if (
        fresh.fingerprint !== context.fingerprint ||
        objectValue(fresh.details.preparation).claimId !== claimId ||
        controller.signal.aborted
      )
        throw conflict("Preparation scope or source changed");
      return fresh;
    };
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void verify()
        .catch(cancel)
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    const timeout = setTimeout(cancel, 6 * 60_000);
    let reason: string | null = null;
    let completed = false;
    try {
      const config = await personalConfiguration(userId);
      const provider = objectValue(config.tailoringProvider);
      if (provider.provider !== "openai" || provider.allowApplicantData !== true)
        throw conflict("Approved OpenAI professional resume review is not configured");
      const options = {
        runtimeDir: path.join(personalRoot(), "storage", userId),
        privateRoot: personalRoot(),
        approval: { provider: "openai" as const, allowApplicantData: true as const },
        signal: controller.signal,
      };
      await verify();
      if (phase === "propose") {
        const result = await this.tailoring.propose(userId, recordId, controller.signal);
        if (result.status !== "proposed") throw conflict(result.reason ?? "Proposal is held");
      } else if (phase === "claim_review") {
        const saved = objectValue(context.details.tailoring);
        const result = await this.claimReview(
          saved.input as TailoringInput,
          saved.proposal as TailoringProposal,
          options,
        );
        if (result.status !== "reviewed") throw conflict(result.reason);
        await verify();
        const { reviewer: _reviewer, reviewedAt: _reviewedAt, ...review } = result.review;
        await this.tailoring.review(userId, recordId, review, result.review.reviewer);
      } else if (phase === "preview") {
        await this.preview.preview(userId, recordId, controller.signal);
      } else {
        const documentCheck = await this.preview.verifyDocument(
          userId,
          recordId,
          controller.signal,
        );
        await verify();
        const pdfHash = String(objectValue(context.details.preview).pdfHash);
        const bytes = new Uint8Array(
          await (await this.personal.pdf(userId, recordId)).arrayBuffer(),
        );
        const directory = path.join(options.runtimeDir, "render-reviews", claimId);
        const rendered = await this.render(bytes, {
          directory,
          pdfHash,
          maxPages: resumePageLimit(context.record),
          signal: controller.signal,
          verifiedPageCount: documentCheck.pageCount ?? undefined,
        });
        const result = await this.renderReview(rendered, options);
        if (result.status !== "reviewed") throw conflict(result.reason);
        await savePrivate(path.join(directory, "review.json"), result);
        if (result.review.decision !== "pass")
          throw conflict("Rendered PDF needs layout corrections");
        await verify();
        await this.preview.review(userId, recordId, {
          pdfHash,
          inspected: true,
          notes: `Independent Codex visual review of all ${rendered.pageCount} rendered pages; evidence ${claimId}`,
        });
      }
      await verify();
      completed = true;
    } catch {
      reason = controller.signal.aborted
        ? "Preparation cancelled by stop, source change, request cancellation or deadline"
        : "Preparation phase held; inspect its private review evidence and required setup";
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
    try {
      const current = await this.prisma.personalRecord.findFirst({
        where: { id: recordId, userId },
      });
      if (!current) throw notFound("Record not found");
      const details = objectValue(current.details);
      if (objectValue(details.preparation).claimId !== claimId)
        throw conflict("Preparation owner changed; results remain private");
      const nextPhase = completed
        ? this.phase(
            details,
            context.inputHash,
            (await this.context(userId, recordId, campaignId)).previewHash,
          )
        : phase;
      const ready = nextPhase === "complete" && objectValue(details.preview).readiness === "ready";
      const nextEligibleAt = ready
        ? null
        : new Date(Date.now() + (completed ? 15_000 : 3_600_000)).toISOString();
      const result = personalPreparationResponseSchema.parse({
        status: ready ? "ready" : completed ? "pending" : "blocked",
        phase: nextPhase,
        reason,
        nextEligibleAt,
      });
      await savePrivate(
        path.join(personalRoot(), "storage", userId, "preparation", `${claimId}.json`),
        {
          ...running,
          ...result,
          finishedAt: new Date().toISOString(),
        },
      );
      const recordUpdatedAt = new Date();
      const changed = await this.prisma.personalRecord.updateMany({
        where: { id: recordId, userId, updatedAt: current.updatedAt },
        data: {
          updatedAt: recordUpdatedAt,
          details: jsonValue({
            ...details,
            preparation: { ...running, ...result, phase, finishedAt: new Date().toISOString() },
          }),
        },
      });
      if (changed.count !== 1)
        throw conflict("Preparation checkpoint changed; inspect retained evidence");
      return { ...result, recordUpdatedAt };
    } catch (error) {
      // If the database is unavailable too, the original bounded lease remains the fallback.
      await this.releaseInterruptedClaim(userId, recordId, claimId).catch(() => undefined);
      throw error;
    }
  }
}
