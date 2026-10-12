import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pageSlice, paginate } from "@jobpilot/contracts/pagination";
import {
  type PersonalBatch,
  type PersonalBatchAnalysis,
  personalBatchAdvanceSchema,
  personalBatchAnalysisSchema,
  personalBatchCreateSchema,
  personalBatchQuerySchema,
  personalBatchSchema,
  personalBatchSuggestSchema,
} from "@jobpilot/contracts/personal-batch";
import { pilotChannel } from "@jobpilot/contracts/sse";
import { singleton } from "tsyringe";
import type { z } from "zod";
import { badRequest, conflict, notFound } from "@/common/errors";
import { publish } from "@/common/sse";
import { type Prisma, PrismaClient } from "@/generated/prisma/client";
import { toPilotQuestion } from "@/modules/pilot/pilot.mapper";
import { recordScopeParkReason, schedulerPolicy } from "../campaign-policy";
import { eligibilityFreshness, eligibilityRefreshClaimed } from "../eligibility-freshness";
import { campaignKeywords } from "../fit-evaluation";
import { manifestHash, readPrivateArtifact } from "../persistence-policy";
import { PersonalService } from "../personal.service";
import { PersonalPreparationService } from "../preparation.service";
import { compareApplicationPriority } from "../queue-priority";
import { jsonValue, objectValue, personalConfiguration, personalRoot } from "../runtime";
import { type BatchContext, buildBatchAnalysis, suggestBatchMembers } from "./batch-analysis";
import { batchCandidate, batchMemberState } from "./batch-context";

type BatchRuntime = Awaited<ReturnType<PersonalBatchesService["context"]>>;
const writableStates = ["discovered", "eligible", "prepared"];

@singleton()
export class PersonalBatchesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
    private readonly preparation: PersonalPreparationService,
  ) {}

  async context(userId: string, campaignId: string, recordIds?: string[]) {
    await personalConfiguration(userId);
    const [campaign, settings, resume] = await Promise.all([
      this.prisma.campaign.findFirst({ where: { campaignId, userId } }),
      this.personal.settings(userId),
      this.personal.resumeData(userId),
    ]);
    if (!campaign) throw notFound("Batch campaign not found");
    const policy = schedulerPolicy(campaign.config);
    if (campaign.status !== "in_progress" || !policy.enabled || !policy.authorization)
      throw conflict("Batch preparation requires an active authorized campaign");
    if (
      policy.authorization.settingsHash !== manifestHash(settings) ||
      policy.authorization.sourceHash !== resume.evidence.sourceHash ||
      policy.authorization.resumeEvidenceId !== resume.evidence.id
    )
      throw conflict("Campaign facts changed; relaunch against the current accepted evidence");
    const conflicts = objectValue(resume.evidence.details).conflicts;
    if (!Array.isArray(conflicts) || conflicts.length)
      throw conflict("Resolve source evidence conflicts before batch analysis");
    const records = await this.prisma.personalRecord.findMany({
      where: {
        userId,
        ...(recordIds
          ? { id: { in: recordIds } }
          : { state: { in: ["discovered", "eligible", "prepared"] } }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(!recordIds ? pageSlice({ page: 1, limit: 50 }) : {}),
    });
    if (recordIds && records.length !== recordIds.length)
      throw notFound("One or more batch records were not found");
    const analysisContext: BatchContext = {
      campaignId,
      runId: policy.authorization.runId,
      evidenceId: resume.evidence.id,
      sourceHash: resume.evidence.sourceHash,
      settingsHash: manifestHash(settings),
      base: resume.data,
      keywords: campaignKeywords(resume.data, settings),
    };
    return { campaign, policy, settings, resume, records, analysisContext };
  }

  private validRecords(context: BatchRuntime) {
    return context.records.filter(
      (record) =>
        !recordScopeParkReason(record, context.policy) &&
        eligibilityFreshness(record, {
          settings: context.settings,
          evidence: context.resume.evidence,
        }).status === "current" &&
        objectValue(objectValue(record.details).eligibility).decision !== "ineligible",
    );
  }

  async suggest(userId: string, input: z.infer<typeof personalBatchSuggestSchema>) {
    const parsed = personalBatchSuggestSchema.parse(input);
    const context = await this.context(userId, parsed.campaignId, parsed.recordIds);
    const candidates = this.validRecords(context)
      .filter(
        (record) => writableStates.includes(record.state) && !eligibilityRefreshClaimed(record),
      )
      .sort(compareApplicationPriority);
    const suggestions = suggestBatchMembers(
      context.analysisContext,
      candidates.map(batchCandidate),
    );
    return {
      examined: context.records.length,
      excluded:
        context.records.length -
        new Set(suggestions.flatMap((item) => item.members.map((member) => member.recordId))).size,
      suggestions: suggestions.map((item) => ({
        recordIds: item.members.map((member) => member.recordId),
        roles: item.members.map(({ recordId, title, company }) => ({ recordId, title, company })),
        track: item.track,
        minimumOverlap: item.overlap.minimum,
        sharedSupportedTerms: item.sharedSupportedTerms,
      })),
    };
  }

  async create(userId: string, input: z.infer<typeof personalBatchCreateSchema>) {
    const parsed = personalBatchCreateSchema.parse(input);
    const context = await this.context(userId, parsed.campaignId, parsed.recordIds);
    if (
      this.validRecords(context).length !== parsed.recordIds.length ||
      context.records.some(
        (record) => !writableStates.includes(record.state) || eligibilityRefreshClaimed(record),
      )
    )
      throw conflict(
        "Every batch member must have current eligible source evidence and no active application or preparation claim",
      );
    let analysis: PersonalBatchAnalysis;
    try {
      analysis = buildBatchAnalysis(context.analysisContext, context.records.map(batchCandidate));
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid batch members");
    }
    const fingerprint = manifestHash(analysis);
    const source = `tailoring_batch:${fingerprint}`;
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const prior = await tx.personalDiscoveryRun.findFirst({ where: { userId, source } });
      if (prior) return { id: prior.id, question: null };
      await this.assertCurrent(tx, userId, context);
      const id = randomUUID();
      const directory = path.join(personalRoot(), "storage", userId, "batch-analysis");
      const bytes = Buffer.from(JSON.stringify(analysis));
      const analysisHash = createHash("sha256").update(bytes).digest("hex");
      const analysisPath = path.join(directory, `${id}.json`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(analysisPath, bytes, { mode: 0o600, flag: "wx" });
      const question = analysis.sourceQuestion
        ? await tx.pilotQuestion.create({
            data: {
              userId,
              kind: "question",
              subjectType: "personal_batch",
              subjectId: id,
              prompt: analysis.sourceQuestion,
              options: [],
              deepLink: "/personal",
            },
          })
        : null;
      await tx.personalDiscoveryRun.create({
        data: {
          id,
          userId,
          source,
          status: "partial",
          details: jsonValue({
            kind: "tailoring_batch",
            analysisPath,
            analysisHash,
            fingerprint,
            campaignId: parsed.campaignId,
            recordIds: parsed.recordIds,
            questionId: question?.id ?? null,
            progress: {},
            claim: null,
            lastAdvancedRecordId: null,
          }),
        },
      });
      for (const record of context.records) {
        const details = objectValue(record.details);
        const history = Array.isArray(details.tailoringBatchHistory)
          ? details.tailoringBatchHistory
          : [];
        const previous = details.tailoringBatch;
        const changed = await tx.personalRecord.updateMany({
          where: { id: record.id, userId, updatedAt: record.updatedAt },
          data: {
            details: jsonValue({
              ...details,
              tailoringBatchHistory: previous ? [...history, previous] : history,
              tailoringBatch: {
                id,
                analysisHash,
                memberInputHash: analysis.members.find((item) => item.recordId === record.id)!
                  .inputHash,
                evidenceId: analysis.evidenceId,
                sourceHash: analysis.sourceHash,
              },
            }),
          },
        });
        if (changed.count !== 1)
          throw conflict("Batch member changed while attaching its shared analysis");
      }
      return { id, question };
    });
    if (outcome.question)
      publish(
        pilotChannel,
        { userId },
        { type: "question.created", question: toPilotQuestion(outcome.question) },
      );
    return this.get(userId, outcome.id);
  }

  private async assertCurrent(tx: Prisma.TransactionClient, userId: string, context: BatchRuntime) {
    const campaign = await tx.campaign.findFirst({
      where: { campaignId: context.campaign.campaignId, userId },
    });
    if (
      !campaign ||
      manifestHash(campaign.config) !== manifestHash(context.campaign.config) ||
      campaign.status !== "in_progress"
    )
      throw conflict("Campaign authorization changed while preparing the batch");
    const evidence = await tx.personalResumeEvidence.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (
      !evidence ||
      evidence.id !== context.resume.evidence.id ||
      evidence.sourceHash !== context.resume.evidence.sourceHash
    )
      throw conflict("Accepted resume evidence changed while preparing the batch");
    for (const record of context.records) {
      const current = await tx.personalRecord.findFirst({ where: { id: record.id, userId } });
      if (!current || current.updatedAt.getTime() !== record.updatedAt.getTime())
        throw conflict("A batch member changed; reload its source evidence");
    }
  }

  private async load(userId: string, id: string) {
    await personalConfiguration(userId);
    const row = await this.prisma.personalDiscoveryRun.findFirst({
      where: { id, userId, source: { startsWith: "tailoring_batch:" } },
    });
    if (!row) throw notFound("Batch not found");
    const details = objectValue(row.details);
    const bytes = await readPrivateArtifact(
      String(details.analysisPath),
      path.join(personalRoot(), "storage", userId),
    );
    if (
      bytes.length > 2_000_000 ||
      createHash("sha256").update(bytes).digest("hex") !== details.analysisHash
    )
      throw conflict("Shared batch analysis failed its integrity check");
    const analysis = personalBatchAnalysisSchema.parse(JSON.parse(bytes.toString()));
    if (
      manifestHash(analysis) !== details.fingerprint ||
      row.source !== `tailoring_batch:${details.fingerprint}`
    )
      throw conflict("Shared batch analysis identity differs from its receipt");
    return { row, details, analysis, analysisHash: String(details.analysisHash) };
  }

  private staleReason(
    loaded: Awaited<ReturnType<PersonalBatchesService["load"]>>,
    context: BatchRuntime,
  ) {
    try {
      if (this.validRecords(context).length !== loaded.analysis.members.length)
        return "Batch member eligibility or campaign source scope changed";
      const current = buildBatchAnalysis(
        context.analysisContext,
        context.records.map(batchCandidate),
      );
      if (manifestHash(current) !== loaded.details.fingerprint)
        return "Posting, campaign, settings or accepted resume revision changed; create a new batch";
      if (
        context.records.some(
          (record) =>
            objectValue(objectValue(record.details).tailoringBatch).analysisHash !==
            loaded.analysisHash,
        )
      )
        return "A member now refers to different shared analysis";
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Batch evidence changed";
    }
  }

  async get(userId: string, id: string): Promise<PersonalBatch> {
    const loaded = await this.load(userId, id);
    let context: BatchRuntime | null = null;
    let staleReason: string | null = null;
    try {
      context = await this.context(
        userId,
        loaded.analysis.campaignId,
        loaded.analysis.members.map((item) => item.recordId),
      );
      staleReason = this.staleReason(loaded, context);
    } catch (error) {
      staleReason =
        error instanceof Error ? error.message : "Current batch evidence is unavailable";
    }
    const progress = objectValue(loaded.details.progress);
    const members = loaded.analysis.members.map((member): PersonalBatch["members"][number] => {
      const record = context?.records.find((item) => item.id === member.recordId);
      if (context && record && !staleReason)
        return batchMemberState(
          record,
          progress[record.id],
          context.settings,
          context.resume.evidence,
          context.resume.data,
        );
      return {
        recordId: member.recordId,
        status: "blocked",
        phase: null,
        reason: staleReason,
        nextEligibleAt: null,
      };
    });
    const question = await this.prisma.pilotQuestion.findFirst({
      where: { userId, subjectType: "personal_batch", subjectId: id },
    });
    let status: PersonalBatch["status"] = "active";
    if (staleReason) status = "stale";
    else if (members.every((member) => member.phase === "complete")) status = "complete";
    return personalBatchSchema.parse({
      id,
      createdAt: loaded.row.createdAt,
      analysisHash: loaded.analysisHash,
      analysis: loaded.analysis,
      status,
      staleReason,
      running:
        Boolean(loaded.details.claim) &&
        Date.parse(String(loaded.details.leaseExpiresAt)) > Date.now(),
      members,
      sourceQuestion: question
        ? {
            id: question.id,
            prompt: question.prompt,
            status: question.status,
            answer: question.answer,
            requiresSourceAcceptance: true,
          }
        : null,
      lastAdvancedRecordId: loaded.details.lastAdvancedRecordId ?? null,
    });
  }

  async list(userId: string, query: z.infer<typeof personalBatchQuerySchema>) {
    await personalConfiguration(userId);
    const where = { userId, source: { startsWith: "tailoring_batch:" } };
    const [rows, total] = await Promise.all([
      this.prisma.personalDiscoveryRun.findMany({
        where,
        ...pageSlice(query),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.personalDiscoveryRun.count({ where }),
    ]);
    return paginate(await Promise.all(rows.map((row) => this.get(userId, row.id))), query, total);
  }

  async advance(
    userId: string,
    id: string,
    input: z.infer<typeof personalBatchAdvanceSchema>,
    signal?: AbortSignal,
  ) {
    const parsed = personalBatchAdvanceSchema.parse(input);
    const view = await this.get(userId, id);
    if (view.analysisHash !== parsed.expectedAnalysisHash)
      throw conflict("Shared analysis changed; reload the batch");
    if (view.status === "stale") throw conflict(view.staleReason ?? "Batch is stale");
    if (view.status === "complete") return view;
    const members = [...view.members];
    const last = members.findIndex((member) => member.recordId === view.lastAdvancedRecordId);
    const ordered = [...members.slice(last + 1), ...members.slice(0, last + 1)];
    const member = ordered.find(
      (item) =>
        item.phase !== "complete" &&
        item.status !== "ready" &&
        (!item.nextEligibleAt || item.nextEligibleAt.getTime() <= Date.now()) &&
        (item.status !== "blocked" || parsed.retryBlocked),
    );
    if (!member || signal?.aborted) return view;
    const claim = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const row = await tx.personalDiscoveryRun.findFirst({ where: { id, userId } });
      if (!row) throw notFound("Batch not found");
      const details = objectValue(row.details);
      if (details.analysisHash !== parsed.expectedAnalysisHash)
        throw conflict("Shared analysis changed");
      if (details.claim && Date.parse(String(details.leaseExpiresAt)) > Date.now())
        throw conflict("Another worker owns this batch checkpoint");
      await tx.personalDiscoveryRun.update({
        where: { id },
        data: {
          details: jsonValue({
            ...details,
            claim,
            leaseExpiresAt: new Date(Date.now() + 16 * 60_000),
            activeRecordId: member.recordId,
          }),
        },
      });
    });
    try {
      const fresh = await this.get(userId, id);
      if (fresh.status === "stale") throw conflict(fresh.staleReason ?? "Batch changed");
      const result = await this.preparation.advance(
        userId,
        member.recordId,
        view.analysis.campaignId,
        signal,
      );
      await this.saveProgress(userId, id, claim, member.recordId, {
        status: result.status === "blocked" ? "blocked" : "pending",
        phase: result.phase,
        reason: result.reason,
        nextEligibleAt: result.nextEligibleAt,
      });
    } catch (error) {
      await this.saveProgress(userId, id, claim, member.recordId, {
        status: "blocked",
        phase: member.phase,
        reason: error instanceof Error ? error.message.slice(0, 2000) : "Member preparation failed",
        nextEligibleAt: null,
      });
    }
    return this.get(userId, id);
  }

  private async saveProgress(
    userId: string,
    id: string,
    claim: string,
    recordId: string,
    result: Record<string, unknown>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const row = await tx.personalDiscoveryRun.findFirst({ where: { id, userId } });
      if (!row || objectValue(row.details).claim !== claim) return;
      const details = objectValue(row.details);
      await tx.personalDiscoveryRun.update({
        where: { id },
        data: {
          details: jsonValue({
            ...details,
            claim: null,
            leaseExpiresAt: null,
            activeRecordId: null,
            lastAdvancedRecordId: recordId,
            progress: { ...objectValue(details.progress), [recordId]: result },
          }),
        },
      });
    });
  }
}
