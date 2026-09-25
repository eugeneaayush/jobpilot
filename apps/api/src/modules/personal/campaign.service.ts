import { pageSlice, paginate } from "@jobpilot/contracts/pagination";
import type {
  PersonalCampaignCreateInput,
  PersonalCampaignNextResponse,
  PersonalCampaignQuery,
} from "@jobpilot/contracts/personal-campaign";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { singleton } from "tsyringe";
import { conflict, HttpError, notFound } from "@/common/errors";
import {
  type PersonalAttempt,
  type PersonalRecord,
  type Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { PersonalAttemptService } from "./attempt.service";
import {
  personalCampaignDto,
  preparedCampaignAnswers,
  recordParkReason,
  schedulerPolicy,
} from "./campaign-policy";
import {
  eligibilityFreshness,
  eligibilityRefreshAttemptWhere,
  eligibilityRefreshClaimed,
} from "./eligibility-freshness";
import {
  manifestHash,
  privateArtifactRoot,
  readPrivateArtifact,
  verifyPrivateArtifact,
} from "./persistence-policy";
import { PersonalService } from "./personal.service";
import { compareApplicationPriority } from "./queue-priority";
import { PersonalReassessmentService } from "./reassessment.service";
import { activeRecoveryRevision, recoveryContext } from "./recovery-policy";
import { jsonValue, objectValue, sha256, textValue } from "./runtime";

@singleton()
export class PersonalCampaignService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
    private readonly attempts: PersonalAttemptService,
  ) {}

  private lock<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!rows.length) throw notFound("User not found");
        return work(tx);
      },
      { timeout: 15000 },
    );
  }

  async create(userId: string, input: PersonalCampaignCreateInput) {
    const campaign = await this.prisma.campaign.create({
      data: {
        userId,
        query: input.name,
        source: "apply",
        status: "paused",
        createdBy: "user",
        config: jsonValue({
          personal: {
            ...input,
            sources: { ...input.sources, boardTokens: [...new Set(input.sources.boardTokens)] },
            tracks: [...new Set(input.tracks)],
            scheduler: "personal-campaign-v1",
            enabled: false,
            policyVersion: crypto.randomUUID(),
            authorization: null,
          },
        }),
      },
    });
    return personalCampaignDto(campaign);
  }

  async list(userId: string, query: PersonalCampaignQuery) {
    const where: Prisma.CampaignWhereInput = {
      userId,
      config: { path: ["personal", "scheduler"], equals: "personal-campaign-v1" },
      ...(query.status && { status: query.status === "active" ? "in_progress" : "paused" }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        ...pageSlice(query),
        orderBy: [{ startedAt: "desc" }, { campaignId: "asc" }],
      }),
      this.prisma.campaign.count({ where }),
    ]);
    return paginate(rows.map(personalCampaignDto), query, total);
  }

  async launch(userId: string, id: string, confirm: boolean) {
    if (!confirm) throw conflict("Explicit campaign launch authorization is required.");
    const settings = await this.personal.settings(userId);
    return this.lock(userId, async (tx) => {
      const campaign = await this.owned(tx, userId, id);
      const policy = schedulerPolicy(campaign.config);
      if (campaign.status === "in_progress" && policy.enabled) return personalCampaignDto(campaign);
      const evidence = await tx.personalResumeEvidence.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      if (!evidence) throw conflict("Import resume evidence before launching a campaign.");
      const conflicts = objectValue(evidence.details).conflicts;
      if (policy.mode === "submit" && (!Array.isArray(conflicts) || conflicts.length))
        throw conflict("Resolve resume evidence conflicts before authorizing submission.");
      const snapshot = {
        settings,
        settingsHash: manifestHash(settings),
        resumeEvidenceId: evidence.id,
        sourceHash: evidence.sourceHash,
        policyVersion: policy.policyVersion,
        sources: policy.sources,
        tracks: policy.tracks,
        ...(policy.roleScope && { roleScope: policy.roleScope }),
        fitThreshold: policy.fitThreshold,
        dailyCap: policy.dailyCap,
        maxApplications: policy.maxApplications,
        timezone: policy.timezone,
        mode: policy.mode,
      };
      const authorization = {
        runId: crypto.randomUUID(),
        authorizedAt: new Date().toISOString(),
        settings,
        settingsHash: snapshot.settingsHash,
        resumeEvidenceId: evidence.id,
        sourceHash: evidence.sourceHash,
        snapshotHash: manifestHash(snapshot),
      };
      const updated = await tx.campaign.update({
        where: { campaignId: id },
        data: {
          status: "in_progress",
          statusActor: "user",
          statusReason: "Explicit personal campaign launch",
          config: jsonValue({
            ...objectValue(campaign.config),
            personal: { ...policy, enabled: true, authorization },
          }),
        },
      });
      return personalCampaignDto(updated);
    });
  }

  async stop(userId: string, id: string, reason?: string) {
    return this.lock(userId, async (tx) => {
      const campaign = await this.owned(tx, userId, id);
      const policy = schedulerPolicy(campaign.config);
      const pending = await tx.personalAttempt.findMany({
        where: { userId, campaignId: id, state: { in: ["preparing", "prepared"] }, submitAt: null },
        select: { id: true },
      });
      const pendingIds = pending.map((a) => a.id);
      await tx.personalAttempt.updateMany({
        where: { id: { in: pendingIds } },
        data: { state: "cancelled", leaseGeneration: { increment: 1 } },
      });
      await tx.personalReservation.deleteMany({ where: { userId, attemptId: { in: pendingIds } } });
      const unresolved = await tx.personalAttempt.findMany({
        where: { userId, campaignId: id, state: { in: ["submitting", "submission_uncertain"] } },
        select: { id: true, recordId: true },
      });
      await tx.personalAttempt.updateMany({
        where: { id: { in: unresolved.map((a) => a.id) } },
        data: { state: "submission_uncertain", leaseGeneration: { increment: 1 } },
      });
      await tx.personalRecord.updateMany({
        where: {
          userId,
          id: { in: unresolved.map((a) => a.recordId) },
          state: { not: "submitted" },
        },
        data: { state: "submission_uncertain" },
      });
      const updated = await tx.campaign.update({
        where: { campaignId: id },
        data: {
          status: "paused",
          statusActor: "user",
          statusReason: reason || "Personal campaign stopped",
          config: jsonValue({
            ...objectValue(campaign.config),
            personal: { ...policy, enabled: false },
          }),
        },
      });
      return personalCampaignDto(updated);
    });
  }

  async next(
    userId: string,
    id: string,
    leaseOwner: string,
  ): Promise<PersonalCampaignNextResponse> {
    const campaign = await this.owned(this.prisma, userId, id);
    const policy = schedulerPolicy(campaign.config);
    const idle = (reasons: string[], parked = 0): PersonalCampaignNextResponse => ({
      status: "idle",
      campaignId: id,
      reasons,
      parked,
    });
    if (campaign.status !== "in_progress" || !policy.enabled || !policy.authorization)
      return idle(["Campaign is stopped or has no explicit launch authorization"]);
    const authorization = policy.authorization;
    const settings = await this.personal.settings(userId);
    if (manifestHash(settings) !== authorization.settingsHash)
      return idle([
        "Recruiting settings changed; stop and launch again to authorize a new snapshot",
      ]);
    const latestEvidence = await this.prisma.personalResumeEvidence.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, sourceHash: true, details: true },
    });
    if (
      latestEvidence?.id !== authorization.resumeEvidenceId ||
      latestEvidence.sourceHash !== authorization.sourceHash
    )
      return idle(["Resume evidence changed; stop and launch again to authorize a new snapshot"]);
    const recovered = await this.attempts.recoverPrepared(
      userId,
      id,
      leaseOwner,
      authorization.runId,
    );
    if (recovered) {
      const record = await this.prisma.personalRecord.findFirst({
        where: { id: recovered.recordId, userId },
      });
      if (!record) throw conflict("Recovered preparation record no longer exists.");
      const freshness = eligibilityFreshness(record, { settings, evidence: latestEvidence });
      if (freshness.status !== "current") return idle([freshness.reason!], 1);
      const reason = recordParkReason(record, policy);
      if (reason) return idle([reason], 1);
      return this.taskResponse(id, policy.mode, recovered, record);
    }
    const reasons = new Set<string>();
    let parked = 0;
    let afterId: string | undefined;
    const candidates: PersonalRecord[] = [];
    while (true) {
      const rows = await this.prisma.personalRecord.findMany({
        where: {
          userId,
          OR: [
            ...policy.sources.boardTokens.map((token) => ({
              identity: { startsWith: `greenhouse:${token}:` },
            })),
            ...(policy.sources.instances ?? []).map((source) => ({
              identity: { startsWith: `${personalSourceIdentity(source)}:` },
            })),
          ],
          state: { notIn: ["applying", "submitted", "submission_uncertain"] },
          ...(afterId && { id: { gt: afterId } }),
        },
        orderBy: { id: "asc" },
        ...pageSlice({ page: 1, limit: 100 }),
      });
      if (!rows.length) break;
      candidates.push(...rows);
      afterId = rows.at(-1)!.id;
    }
    const eligibilitySources = { settings, evidence: latestEvidence };
    const pinnedAttempts = await this.prisma.personalAttempt.findMany({
      where: {
        ...eligibilityRefreshAttemptWhere(userId),
        recordId: { in: candidates.map((record) => record.id) },
      },
      select: { recordId: true },
    });
    const pinnedIds = new Set(pinnedAttempts.map((attempt) => attempt.recordId));
    const staleIds = candidates
      .filter(
        (record) =>
          !pinnedIds.has(record.id) &&
          !eligibilityRefreshClaimed(record) &&
          eligibilityFreshness(record, eligibilitySources).status !== "current",
      )
      .slice(0, 25)
      .map((record) => record.id);
    if (staleIds.length) {
      await new PersonalReassessmentService(this.prisma, this.personal).refreshStale(
        userId,
        staleIds,
      );
      const refreshed = await this.prisma.personalRecord.findMany({
        where: { userId, id: { in: staleIds } },
      });
      const byId = new Map(refreshed.map((record) => [record.id, record]));
      for (let index = 0; index < candidates.length; index++) {
        const updated = byId.get(candidates[index]!.id);
        if (updated) candidates[index] = updated;
      }
    }
    candidates.sort((a, b) => compareApplicationPriority(a, b));
    for (const record of candidates) {
      const freshness = eligibilityFreshness(record, eligibilitySources);
      if (freshness.status !== "current") {
        reasons.add(freshness.reason!);
        parked++;
        continue;
      }
      const prior = await this.prisma.personalAttempt.findFirst({
        where: {
          userId,
          recordId: record.id,
          campaignId: id,
          manifest: { path: ["campaignRunId"], equals: authorization.runId },
          NOT: { state: "cancelled", receipt: { path: ["expiredPreparation"], equals: true } },
        },
        orderBy: { attemptNo: "desc" },
      });
      if (prior) {
        const ticket = objectValue(objectValue(record.details).recoveryTicket);
        const revision = activeRecoveryRevision(
          record.details,
          id,
          authorization.runId,
          recoveryContext(record, settings, latestEvidence),
        );
        if (
          !revision ||
          ticket.fromAttemptId !== prior.id ||
          prior.submitAt ||
          !["blocked", "failed"].includes(prior.state)
        )
          continue;
      }
      const reason = recordParkReason(record, policy);
      if (reason) {
        reasons.add(reason);
        parked++;
        continue;
      }
      const reservation = await this.prisma.personalReservation.findFirst({
        where: { userId, OR: [{ identity: record.identity }, { url: record.url }] },
        include: { attempt: { select: { state: true, submitAt: true, leaseExpiresAt: true } } },
      });
      if (
        reservation &&
        (reservation.attempt.submitAt || reservation.attempt.leaseExpiresAt > new Date())
      ) {
        reasons.add("Another attempt owns this identity or has an unresolved submission");
        parked++;
        continue;
      }
      let attemptId: string | undefined;
      let leaseGeneration: number | undefined;
      try {
        const details = objectValue(record.details);
        const manifestBytes = await readPrivateArtifact(
          textValue(details.manifestPath),
          privateArtifactRoot(userId),
        );
        const preview = objectValue(details.preview);
        if (sha256(manifestBytes) !== textValue(preview.manifestHash))
          throw conflict("Prepared manifest hash does not match the preview");
        const prepared = objectValue(JSON.parse(manifestBytes.toString()));
        const document = objectValue(prepared.document);
        if (
          prepared.recordId !== record.id ||
          prepared.resumeEvidenceId !== authorization.resumeEvidenceId ||
          prepared.sourceHash !== authorization.sourceHash ||
          document.sha256 !== preview.pdfHash
        )
          throw conflict("Prepared document is outside the authorized resume snapshot");
        await verifyPrivateArtifact(
          textValue(document.path),
          textValue(document.sha256),
          privateArtifactRoot(userId),
        );
        const manifest = {
          ...prepared,
          answers: preparedCampaignAnswers(prepared.answers),
          campaignRunId: authorization.runId,
          campaignSnapshotHash: authorization.snapshotHash,
          previewMode: policy.mode,
          ...(policy.mode === "submit" && {
            readiness: { eligibility: "eligible", document: "ready", answers: "ready" },
          }),
        };
        const attempt = await this.attempts.start(userId, {
          recordId: record.id,
          campaignId: id,
          mode: policy.mode,
          leaseOwner,
          manifest: JSON.parse(JSON.stringify(manifest)),
        });
        attemptId = attempt.id;
        leaseGeneration = attempt.leaseGeneration;
        const ready = await this.attempts.prepare(userId, attempt.id, {
          leaseOwner,
          leaseGeneration: attempt.leaseGeneration,
        });
        return this.taskResponse(id, policy.mode, ready, record);
      } catch (error) {
        if (attemptId && leaseGeneration) {
          try {
            await this.attempts.cancel(userId, attemptId, { leaseOwner, leaseGeneration });
          } catch {
            /* Stop or another owner already revoked preparation. */
          }
        }
        if (
          !(error instanceof HttpError) &&
          !(error instanceof SyntaxError) &&
          !(
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "EACCES"].includes(String(error.code))
          )
        )
          throw error;
        reasons.add(
          error instanceof HttpError
            ? error.message
            : "Prepared artifact is unavailable or invalid",
        );
        parked++;
      }
    }
    return idle(
      reasons.size
        ? [...reasons].slice(0, 20)
        : ["No prepared records match the selected sources, tracks, and current launch"],
      parked,
    );
  }

  private taskResponse(
    campaignId: string,
    mode: "submit" | "offline",
    attempt: PersonalAttempt,
    record: PersonalRecord,
  ): PersonalCampaignNextResponse {
    return {
      status: "task",
      campaignId,
      mode,
      attempt: {
        id: attempt.id,
        leaseOwner: attempt.leaseOwner,
        leaseGeneration: attempt.leaseGeneration,
        manifestHash: attempt.manifestHash,
        state: "prepared",
      },
      record: {
        id: record.id,
        identity: record.identity,
        title: record.title,
        company: record.company,
        url: record.url,
        track: record.track,
      },
      task: {
        kind: mode === "submit" ? "apply" : "offline_preview",
        applicationMethod: objectValue(record.details).applicationEmail
          ? "official_email"
          : "browser",
        attemptId: attempt.id,
        brokerPath: `/api/personal/attempts/${attempt.id}`,
      },
    };
  }

  private async owned(db: Pick<Prisma.TransactionClient, "campaign">, userId: string, id: string) {
    const campaign = await db.campaign.findFirst({ where: { campaignId: id, userId } });
    if (!campaign) throw notFound("Personal campaign not found");
    schedulerPolicy(campaign.config);
    return campaign;
  }
}
