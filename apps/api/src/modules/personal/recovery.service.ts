import type {
  PersonalEligibilityAdjudicationInput,
  PersonalRecordRecoveryInput,
  PersonalRecoveryContext,
} from "@jobpilot/contracts/personal-recovery";
import { singleton } from "tsyringe";
import { conflict, notFound } from "@/common/errors";
import { type PersonalAttempt, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { recordScopeParkReason, schedulerPolicy } from "./campaign-policy";
import { verifyRecruitingConstraints } from "./graduate-eligibility-policy";
import { seniorityParkReason } from "./graduate-policy";
import { manifestHash } from "./persistence-policy";
import {
  adjudicatedRequirements,
  overallEligibility,
  recoveryContext,
  sameRecoveryContext,
  validateEligibilityDecision,
} from "./recovery-policy";
import { jsonValue, objectValue, readSettings, stringsValue, textValue } from "./runtime";

type Db = Pick<
  Prisma.TransactionClient,
  "personalRecord" | "personalResumeEvidence" | "personalAttempt" | "campaign"
>;

@singleton()
export class PersonalRecoveryService {
  constructor(private readonly prisma: PrismaClient) {}

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

  private async load(db: Db, userId: string, recordId: string) {
    const record = await db.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Personal record not found");
    const [settings, evidence, attempts] = await Promise.all([
      readSettings(userId),
      db.personalResumeEvidence.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
      db.personalAttempt.findMany({
        where: { userId, recordId },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    if (!evidence) throw conflict("Import current resume evidence before reviewing this record");
    return {
      record,
      settings,
      evidence,
      attempts,
      context: recoveryContext(record, settings, evidence),
    };
  }

  private requireVersion(
    loaded: Awaited<ReturnType<PersonalRecoveryService["load"]>>,
    input: { expectedUpdatedAt: string; context: PersonalRecoveryContext },
  ) {
    if (loaded.record.updatedAt.toISOString() !== input.expectedUpdatedAt)
      throw conflict("Record changed; reload recovery evidence before saving");
    if (!sameRecoveryContext(input.context, loaded.context))
      throw conflict(
        "Posting, settings, requirements or resume evidence changed; reload the source context",
      );
  }

  private requireNoSubmission(attempts: PersonalAttempt[], state: string) {
    if (
      ["applying", "submitted", "submission_uncertain"].includes(state) ||
      attempts.some(
        (attempt) =>
          ["submitting", "submitted", "submission_uncertain"].includes(attempt.state) ||
          (attempt.submitAt &&
            !(
              attempt.state === "cancelled" &&
              objectValue(attempt.receipt).outcome === "not_submitted" &&
              objectValue(attempt.receipt).manifestHash === attempt.manifestHash
            )),
      )
    )
      throw conflict(
        "Possible or confirmed submission requires reconciliation before any recovery",
      );
    if (attempts.some((attempt) => ["preparing", "prepared"].includes(attempt.state)))
      throw conflict(
        "Stop the active preparation before changing eligibility or recovering this record",
      );
  }

  private verifyEligible(
    loaded: Awaited<ReturnType<PersonalRecoveryService["load"]>>,
    details: Record<string, unknown>,
  ) {
    const record = { ...loaded.record, details: jsonValue(details) as Prisma.JsonObject };
    const seniority = seniorityParkReason(record);
    if (seniority) throw conflict(seniority);
    verifyRecruitingConstraints(record, loaded.settings, loaded.evidence);
  }

  async get(userId: string, recordId: string, targetCampaignId?: string) {
    const loaded = await this.load(this.prisma, userId, recordId);
    return this.response(this.prisma, loaded, targetCampaignId);
  }

  private async recoveryCampaign(
    db: Db,
    loaded: Awaited<ReturnType<PersonalRecoveryService["load"]>>,
    targetCampaignId?: string,
  ) {
    const attempt = loaded.attempts[0];
    const campaignId = targetCampaignId ?? attempt?.campaignId;
    const result = { campaignId, campaignRunId: null as string | null, blockers: [] as string[] };
    if (!campaignId) return result;
    const campaign = await db.campaign.findFirst({
      where: { campaignId, userId: loaded.record.userId },
    });
    if (!campaign) {
      result.blockers.push(
        targetCampaignId ? "Target campaign is unavailable" : "Original campaign no longer exists",
      );
      return result;
    }
    try {
      const policy = schedulerPolicy(campaign.config);
      const authorization = policy.authorization;
      result.campaignRunId = authorization?.runId ?? null;
      if (targetCampaignId && (campaign.status !== "in_progress" || !policy.enabled))
        result.blockers.push("Target campaign must be active and explicitly authorized");
      if (!authorization) result.blockers.push("Campaign has no prior launch authorization");
      if (
        authorization &&
        (authorization.settingsHash !== loaded.context.settingsHash ||
          authorization.resumeEvidenceId !== loaded.context.resumeEvidenceId ||
          authorization.sourceHash !== loaded.context.sourceHash)
      )
        result.blockers.push("Campaign source snapshot changed");
      if (targetCampaignId && attempt && policy.mode !== attempt.mode)
        result.blockers.push("Recovery transfer cannot change the original attempt mode");
      const scope = recordScopeParkReason(loaded.record, policy);
      if (scope) result.blockers.push(scope);
    } catch {
      result.blockers.push(
        targetCampaignId
          ? "Target campaign is not a configured personal campaign"
          : "Original campaign is not a configured personal campaign",
      );
    }
    return result;
  }

  private async canSupersedeTransfer(
    db: Db,
    loaded: Awaited<ReturnType<PersonalRecoveryService["load"]>>,
    ticket: Record<string, unknown>,
    targetCampaignId?: string,
  ) {
    if (
      !targetCampaignId ||
      typeof ticket.originalCampaignId !== "string" ||
      typeof ticket.campaignId !== "string" ||
      (ticket.originalCampaignId === ticket.campaignId &&
        ticket.targetCampaignId !== ticket.campaignId) ||
      typeof ticket.revision !== "string" ||
      typeof ticket.campaignRunId !== "string" ||
      typeof ticket.createdAt !== "string" ||
      !Number.isFinite(Date.parse(ticket.createdAt)) ||
      loaded.attempts.some(
        (attempt) => objectValue(attempt.manifest).recoveryRevision === ticket.revision,
      )
    )
      return false;
    const history = objectValue(loaded.record.details).recoveryHistory;
    if (
      !Array.isArray(history) ||
      !history.some((event) => manifestHash(event) === manifestHash(ticket))
    )
      return false;
    const previousTarget = await db.campaign.findFirst({
      where: { campaignId: ticket.campaignId, userId: loaded.record.userId },
    });
    if (!previousTarget) return true;
    try {
      const policy = schedulerPolicy(previousTarget.config);
      return (
        previousTarget.status !== "in_progress" ||
        !policy.enabled ||
        policy.authorization?.runId !== ticket.campaignRunId ||
        !sameRecoveryContext(ticket.context, loaded.context)
      );
    } catch {
      return true;
    }
  }

  async adjudicate(userId: string, recordId: string, input: PersonalEligibilityAdjudicationInput) {
    await this.lock(userId, async (tx) => {
      const loaded = await this.load(tx, userId, recordId);
      this.requireVersion(loaded, input);
      this.requireNoSubmission(loaded.attempts, loaded.record.state);
      const { record, settings, evidence, context } = loaded;
      for (const decision of input.decisions)
        validateEligibilityDecision(decision, record, settings, evidence, context);
      const details = objectValue(record.details);
      const history = Array.isArray(details.eligibilityAdjudicationHistory)
        ? details.eligibilityAdjudicationHistory
        : [];
      if (history.length >= 100) throw conflict("Eligibility decision history limit reached");
      const previous = objectValue(details.eligibilityAdjudication);
      const decisions = new Map<string, unknown>();
      if (sameRecoveryContext(previous.context ?? {}, context) && Array.isArray(previous.decisions))
        for (const decision of previous.decisions)
          decisions.set(textValue(objectValue(decision).requirementId), decision);
      for (const decision of input.decisions) decisions.set(decision.requirementId, decision);
      const adjudication = {
        id: crypto.randomUUID(),
        kind: "eligibility",
        context,
        contextHash: manifestHash(context),
        actorId: userId,
        createdAt: new Date().toISOString(),
        decisions: [...decisions.values()],
        reason: "Explicit requirement-by-requirement source review",
        priorEligibility: details.eligibility ?? null,
        invalidatedPreview: details.preview ?? null,
      };
      const next = { ...details, eligibilityAdjudication: adjudication };
      const requirements = adjudicatedRequirements(next, context);
      const eligibility = overallEligibility(requirements);
      if (eligibility === "eligible") this.verifyEligible(loaded, next);
      const names = new Set(requirements.map((requirement) => requirement.requirement));
      const missingAnswers = [
        ...new Set([
          ...stringsValue(details.missingAnswers).filter((question) => !names.has(question)),
          ...requirements
            .filter((requirement) => requirement.status === "unknown")
            .map((requirement) => requirement.requirement),
        ]),
      ];
      const nextDetails = this.withoutPreview({
        ...next,
        eligibility: {
          decision: eligibility,
          reasons: requirements.map(
            (requirement) =>
              `${requirement.status}: ${requirement.requirement} — ${requirement.evidence}`,
          ),
        },
        missingAnswers,
        eligibilityAdjudicationHistory: [...history, adjudication],
      });
      let state = record.state;
      if (!["blocked", "failed"].includes(state))
        state = eligibility === "eligible" ? "eligible" : "discovered";
      const changed = await tx.personalRecord.updateMany({
        where: { id: record.id, userId, updatedAt: record.updatedAt },
        data: { state, details: jsonValue(nextDetails) },
      });
      if (changed.count !== 1) throw conflict("Record changed during eligibility review");
    });
    return this.get(userId, recordId);
  }

  async recover(userId: string, recordId: string, input: PersonalRecordRecoveryInput) {
    await this.lock(userId, async (tx) => {
      const loaded = await this.load(tx, userId, recordId);
      this.requireVersion(loaded, input);
      this.requireNoSubmission(loaded.attempts, loaded.record.state);
      const attempt = loaded.attempts[0];
      if (
        !attempt ||
        attempt.id !== input.attemptId ||
        !["blocked", "failed"].includes(attempt.state) ||
        attempt.submitAt
      )
        throw conflict("Recovery requires the latest pre-submission blocked or failed attempt");
      const campaign = await this.recoveryCampaign(tx, loaded, input.targetCampaignId);
      if (campaign.blockers.length) throw conflict(campaign.blockers[0]!);
      if (!campaign.campaignRunId || campaign.campaignRunId !== input.campaignRunId)
        throw conflict("Campaign authorization changed; reload the existing launch context");
      const details = objectValue(loaded.record.details);
      const failed = loaded.attempts.filter(
        (item) => item.mode === attempt.mode && item.state === "failed" && !item.submitAt,
      ).length;
      if (failed >= 3)
        throw conflict("True failure retry limit reached: initial attempt plus two retries");
      const history = Array.isArray(details.recoveryHistory) ? details.recoveryHistory : [];
      if (history.length >= 100) throw conflict("Recovery history limit reached");
      const priorTicket = objectValue(details.recoveryTicket);
      let supersedesRevision: string | undefined;
      if (priorTicket.fromAttemptId === attempt.id) {
        if (!(await this.canSupersedeTransfer(tx, loaded, priorTicket, input.targetCampaignId)))
          throw conflict("This attempt already has a recovery revision");
        supersedesRevision = String(priorTicket.revision);
      }
      this.validateProof(
        input,
        attempt,
        details,
        loaded.context,
        supersedesRevision ? String(priorTicket.createdAt) : undefined,
      );
      const revision = crypto.randomUUID();
      const event = {
        id: revision,
        revision,
        ...(supersedesRevision && { supersedesRevision }),
        kind: "recovery",
        actorId: userId,
        createdAt: new Date().toISOString(),
        fromAttemptId: attempt.id,
        originalCampaignId: attempt.campaignId,
        originalCampaignRunId: textValue(objectValue(attempt.manifest).campaignRunId) || null,
        ...(input.targetCampaignId && { targetCampaignId: input.targetCampaignId }),
        campaignId: campaign.campaignId,
        campaignRunId: campaign.campaignRunId,
        context: loaded.context,
        contextHash: manifestHash(loaded.context),
        reason: input.reason,
        proof: input.proof,
        outcome: "ready_for_recheck",
        priorState: loaded.record.state,
        invalidatedPreview: details.preview ?? null,
      };
      const requirements = adjudicatedRequirements(details, loaded.context);
      const decision = overallEligibility(requirements);
      if (decision === "eligible") this.verifyEligible(loaded, details);
      // This requeues evidence review; no campaign, attempt or submission authority is created here.
      const changed = await tx.personalRecord.updateMany({
        where: { id: recordId, userId, updatedAt: loaded.record.updatedAt },
        data: {
          state: decision === "eligible" ? "eligible" : "discovered",
          details: jsonValue(
            this.withoutPreview({
              ...details,
              eligibility: {
                decision,
                reasons: requirements.map(
                  (requirement) =>
                    `${requirement.status}: ${requirement.requirement} — ${requirement.evidence}`,
                ),
              },
              recoveryTicket: event,
              recoveryHistory: [...history, event],
            }),
          ),
        },
      });
      if (changed.count !== 1) throw conflict("Record changed during recovery");
    });
    return this.get(userId, recordId, input.targetCampaignId);
  }

  private validateProof(
    input: PersonalRecordRecoveryInput,
    attempt: PersonalAttempt,
    details: Record<string, unknown>,
    context: PersonalRecoveryContext,
    freshAfter?: string,
  ) {
    const proof = input.proof;
    const securityBlock =
      /login|captcha|security|challenge|verification|account creation|terms/i.test(
        textValue(objectValue(attempt.receipt).reason),
      );
    if (securityBlock && proof.kind !== "browser_session")
      throw conflict("A login or security block needs server-verified browser session evidence");
    if (proof.kind === "retry_failure") {
      if (freshAfter) throw conflict("Reissuing a transfer requires fresh source or browser proof");
      if (attempt.state !== "failed")
        throw conflict("An unresolved user or security block is not a retryable failure");
      return;
    }
    const fresh = (value: unknown) =>
      typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      Date.parse(value) >= attempt.updatedAt.getTime() &&
      (!freshAfter || Date.parse(value) > Date.parse(freshAfter));
    if (proof.kind === "screening_answers") {
      const snapshot = objectValue(details.screeningAnswers);
      if (
        snapshot.snapshotHash !== proof.snapshotHash ||
        snapshot.identity !== context.identity ||
        snapshot.postingContentHash !== context.postingHash ||
        snapshot.settingsHash !== context.settingsHash ||
        !fresh(snapshot.createdAt)
      )
        throw conflict(
          "Recovery needs a fresh immutable answer snapshot under the current sources",
        );
    }
    if (proof.kind === "eligibility") {
      const adjudication = objectValue(details.eligibilityAdjudication);
      if (
        adjudication.id !== proof.adjudicationId ||
        !sameRecoveryContext(adjudication.context ?? {}, context) ||
        !fresh(adjudication.createdAt) ||
        overallEligibility(adjudicatedRequirements(details, context)) !== "eligible"
      )
        throw conflict("Recovery needs a fresh complete source-grounded eligibility review");
    }
    if (proof.kind === "browser_session") {
      const session = objectValue(details.browserSessionEvidence);
      if (
        session.verified !== true ||
        session.sessionId !== proof.sessionId ||
        session.sha256 !== proof.sha256 ||
        session.postingContentHash !== context.postingHash ||
        !fresh(session.verifiedAt)
      )
        throw conflict(
          "Recovery needs fresh server-verified browser session evidence for this posting",
        );
    }
    const reason = textValue(objectValue(attempt.receipt).reason);
    if (
      /login|captcha|security|challenge|verification|account creation|terms/i.test(reason) &&
      proof.kind !== "browser_session"
    )
      throw conflict("A login or security block needs server-verified browser session evidence");
  }

  private withoutPreview(details: Record<string, unknown>) {
    const {
      preview: _preview,
      document: _document,
      manifestPath: _manifestPath,
      renderReview: _review,
      ...rest
    } = details;
    return rest;
  }

  private async response(
    db: Db,
    loaded: Awaited<ReturnType<PersonalRecoveryService["load"]>>,
    targetCampaignId?: string,
  ) {
    const { record, context, attempts } = loaded;
    const details = objectValue(record.details);
    const latest = attempts[0];
    const blockers: string[] = [];
    try {
      this.requireNoSubmission(attempts, record.state);
    } catch (error) {
      blockers.push((error as Error).message);
    }
    if (!latest || !["blocked", "failed"].includes(latest.state))
      blockers.push("No latest blocked or failed attempt to recover");
    const ticket = objectValue(details.recoveryTicket);
    if (
      latest &&
      ticket.fromAttemptId === latest.id &&
      !(await this.canSupersedeTransfer(db, loaded, ticket, targetCampaignId))
    )
      blockers.push("Recovery is already queued for this attempt");
    const failedAttempts = attempts.filter(
      (attempt) => attempt.state === "failed" && !attempt.submitAt && attempt.mode === latest?.mode,
    ).length;
    if (failedAttempts >= 3) blockers.push("True failure retry limit reached");
    const campaign = await this.recoveryCampaign(db, loaded, targetCampaignId);
    blockers.push(...campaign.blockers);
    const requirements = adjudicatedRequirements(details, context);
    let eligibility = overallEligibility(requirements);
    if (eligibility === "eligible") {
      try {
        this.verifyEligible(loaded, details);
      } catch (error) {
        eligibility = "unknown";
        blockers.push((error as Error).message);
      }
    }
    const posting = objectValue(details.posting);
    const history = [
      ...(Array.isArray(details.eligibilityAdjudicationHistory)
        ? details.eligibilityAdjudicationHistory
        : []),
      ...(Array.isArray(details.recoveryHistory) ? details.recoveryHistory : []),
    ]
      .map(objectValue)
      .sort((a, b) => textValue(b.createdAt).localeCompare(textValue(a.createdAt)))
      .slice(0, 20)
      .map((event) => ({
        id: textValue(event.id),
        kind: event.kind as "eligibility" | "recovery",
        createdAt: new Date(textValue(event.createdAt)),
        reason: textValue(event.reason),
        contextHash: textValue(event.contextHash),
      }));
    return {
      recordId: record.id,
      updatedAt: record.updatedAt,
      context,
      source: {
        title: record.title,
        descriptionText: textValue(posting.descriptionText),
        url: record.url,
      },
      requirements,
      eligibility,
      latestAttempt: latest
        ? {
            id: latest.id,
            state: latest.state,
            submitAt: latest.submitAt,
            reason: textValue(objectValue(latest.receipt).reason) || null,
          }
        : null,
      recovery: {
        allowed: blockers.length === 0,
        blockers,
        failedAttempts,
        retriesRemaining: Math.max(0, 3 - failedAttempts),
        campaignRunId: campaign.campaignRunId,
        ...(targetCampaignId && { targetCampaignId }),
      },
      history,
    };
  }
}
