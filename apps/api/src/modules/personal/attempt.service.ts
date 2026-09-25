import { applicationEmailTransportFreezeSchema } from "@jobpilot/contracts/personal-application-email";
import type {
  PersonalAttemptLeaseInput,
  PersonalAttemptStartInput,
  PersonalReceiptEvidence,
} from "@jobpilot/contracts/personal-attempt";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import { singleton } from "tsyringe";
import { z } from "zod";
import { conflict, notFound } from "@/common/errors";
import { type PersonalAttempt, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { canonicalizeJobUrl } from "@/modules/application/job-url";
import { prepareApplicationEmail } from "./application-email/policy";
import { verifyAttachmentManifest } from "./attachments-policy";
import { recordScopeParkReason } from "./campaign-policy";
import { validateChallengeAcceptance } from "./challenge-policy";
import { eligibilityFreshness } from "./eligibility-freshness";
import { verifyRecruitingConstraints } from "./graduate-eligibility-policy";
import { seniorityParkReason } from "./graduate-policy";
import {
  manifestHash,
  policyDay,
  privateArtifactRoot,
  readAttemptPolicy,
  readPrivateArtifact,
  trustedRequisition,
  verifyPrivateArtifact,
} from "./persistence-policy";
import { activeRecoveryRevision, recoveryContext, sameRecoveryContext } from "./recovery-policy";
import { objectValue, readSettings, sha256 } from "./runtime";
import { validateManifestScreeningSources } from "./screening-provenance";
import { employerIdentity, enforceEmployerCap, userPolicy } from "./user-policy";

const LEASE_MS = 90_000;
const RESERVED_STATES = [
  "previewed",
  "preparing",
  "prepared",
  "submitting",
  "submitted",
  "submission_uncertain",
] as const;
const submitManifestSchema = z.object({
  recordId: z.uuid(),
  previewMode: z.literal("submit"),
  document: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  resumeEvidenceId: z.uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  readiness: z.object({
    eligibility: z.literal("eligible"),
    document: z.literal("ready"),
    answers: z.literal("ready"),
  }),
});

@singleton()
export class PersonalAttemptService {
  constructor(private readonly prisma: PrismaClient) {}

  private async locked<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(
      async (tx) => {
        // One user lock serializes identities and quota reservations across every campaign.
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!rows.length) throw notFound("User not found");
        return work(tx);
      },
      { timeout: 15000 },
    );
  }

  async get(userId: string, id: string) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      return this.expireSubmission(tx, attempt);
    });
  }

  async recoverPrepared(
    userId: string,
    campaignId: string,
    leaseOwner: string,
    campaignRunId: string,
  ) {
    return this.locked(userId, async (tx) => {
      await this.sweepExpiredPreparations(tx, userId);
      const campaign = await tx.campaign.findFirst({
        where: { userId, campaignId, status: "in_progress" },
      });
      const policy = objectValue(objectValue(campaign?.config).personal);
      if (
        !campaign ||
        policy.enabled !== true ||
        objectValue(policy.authorization).runId !== campaignRunId
      )
        return null;
      const attempt = await tx.personalAttempt.findFirst({
        where: {
          userId,
          campaignId,
          leaseOwner,
          state: "prepared",
          submitAt: null,
          leaseExpiresAt: { gt: new Date() },
          manifest: { path: ["campaignRunId"], equals: campaignRunId },
        },
        orderBy: { startedAt: "asc" },
      });
      if (!attempt) return null;
      this.requireLease(attempt, attempt);
      await this.verifyDocument(userId, attempt.manifest);
      if (attempt.mode === "submit")
        await this.verifyManifest(tx, userId, attempt.recordId, attempt.manifest);
      return attempt;
    });
  }

  private async sweepExpiredPreparations(tx: Prisma.TransactionClient, userId: string) {
    const expired = await tx.personalAttempt.findMany({
      where: {
        userId,
        submitAt: null,
        state: { in: ["preparing", "prepared"] },
        leaseExpiresAt: { lte: new Date() },
      },
      select: { id: true },
    });
    if (!expired.length) return;
    const ids = expired.map((attempt) => attempt.id);
    await tx.personalAttempt.updateMany({
      where: { userId, id: { in: ids }, submitAt: null, state: { in: ["preparing", "prepared"] } },
      data: {
        state: "cancelled",
        leaseGeneration: { increment: 1 },
        receipt: {
          outcome: "cancelled",
          expiredPreparation: true,
          reason: "Preparation lease expired before submission",
          expiredAt: new Date().toISOString(),
        },
      },
    });
    await tx.personalReservation.deleteMany({ where: { userId, attemptId: { in: ids } } });
  }

  async start(userId: string, input: PersonalAttemptStartInput) {
    return this.locked(userId, async (tx) => {
      const campaign = await tx.campaign.findFirst({
        where: { campaignId: input.campaignId, userId, status: "in_progress" },
      });
      if (!campaign) throw conflict("An owned active campaign is required.");
      const policy = readAttemptPolicy(campaign.config);
      if (policy.mode !== input.mode)
        throw conflict("Attempt mode must match the campaign policy.");
      const record = await tx.personalRecord.findFirst({ where: { id: input.recordId, userId } });
      if (!record) throw notFound("Personal record not found");
      if (input.mode === "submit") {
        const reason = seniorityParkReason(record);
        if (reason) throw conflict(reason);
      }
      if (policy.roleScope) {
        const reason = recordScopeParkReason(record, policy);
        if (reason) throw conflict(reason);
      }
      const requisition = trustedRequisition(record, await employerIdentity(tx, userId, record));
      await this.sweepExpiredPreparations(tx, userId);
      const failedPreparations = await tx.personalAttempt.count({
        where: {
          userId,
          recordId: record.id,
          mode: input.mode,
          submitAt: null,
          state: "failed",
        },
      });
      if (failedPreparations >= 3)
        throw conflict("True failure retry limit reached: initial attempt plus two retries.");
      if (["submitted", "submission_uncertain", "applying"].includes(record.state))
        throw conflict("This record has an existing or unresolved submission.");
      if (input.mode === "submit") {
        if (!["eligible", "prepared"].includes(record.state))
          throw conflict("Only an eligible record may enter submit mode.");
        await this.verifyManifest(tx, userId, record.id, input.manifest);
      } else {
        await this.verifyDocument(userId, input.manifest);
      }
      const url = canonicalizeJobUrl(record.url);
      if (
        input.mode === "submit" &&
        (await tx.application.findUnique({ where: { userId_url: { userId, url } } }))
      )
        throw conflict("Already applied to this canonical URL.");
      const reservations = await this.jobReservations(
        tx,
        userId,
        record.identity,
        url,
        requisition.submissionIdentity,
        requisition.employerRequisitionKey,
      );
      for (const reservation of reservations) {
        const old = await this.expireSubmission(tx, reservation.attempt);
        if (old.submitAt || ["submitted", "submission_uncertain", "submitting"].includes(old.state))
          throw conflict(
            "A submission reservation exists; reconcile it with evidence before retrying.",
          );
        if (old.leaseExpiresAt > new Date() && ["preparing", "prepared"].includes(old.state))
          throw conflict("Another attempt owns this job lease.");
        await tx.personalAttempt.update({
          where: { id: old.id },
          data: { state: "cancelled", leaseGeneration: { increment: 1 } },
        });
        await tx.personalReservation.delete({ where: { id: reservation.id } });
      }
      const globalPolicy = await userPolicy(tx, userId);
      if (input.mode === "submit" && policy.timezone !== globalPolicy.timezone)
        throw conflict("Campaign timezone must match the authoritative user policy.");
      const day = policyDay(input.mode === "submit" ? globalPolicy.timezone : policy.timezone);
      if (input.mode === "submit")
        await enforceEmployerCap(
          tx,
          userId,
          await employerIdentity(tx, userId, record),
          globalPolicy.employerActiveCap,
        );
      await this.checkCaps(tx, userId, input.campaignId, policy, day, input.mode);
      const previous = await tx.personalAttempt.findFirst({
        where: { recordId: record.id },
        orderBy: { attemptNo: "desc" },
      });
      const settings = await readSettings(userId);
      const settingsHash = manifestHash(settings);
      const authorization = objectValue(
        objectValue(objectValue(campaign.config).personal).authorization,
      );
      if (authorization.settingsHash && authorization.settingsHash !== settingsHash)
        throw conflict("Recruiting settings changed since campaign authorization.");
      let recoveryRevision: string | null = null;
      if (previous && ["blocked", "failed"].includes(previous.state)) {
        const evidence = await tx.personalResumeEvidence.findFirst({
          where: { userId },
          orderBy: { createdAt: "desc" },
        });
        const ticket = objectValue(objectValue(record.details).recoveryTicket);
        if (
          (typeof ticket.targetCampaignId === "string" ||
            (typeof ticket.originalCampaignId === "string" &&
              ticket.originalCampaignId !== input.campaignId)) &&
          ticket.campaignRunId !== authorization.runId
        )
          throw conflict("Recovery transfer belongs to a different target campaign run.");
        if (
          evidence &&
          typeof authorization.runId === "string" &&
          authorization.resumeEvidenceId === evidence.id &&
          authorization.sourceHash === evidence.sourceHash &&
          typeof ticket.campaignRunId === "string"
        )
          recoveryRevision = activeRecoveryRevision(
            record.details,
            input.campaignId,
            ticket.campaignRunId,
            recoveryContext(record, settings, evidence),
          );
        if (!recoveryRevision || ticket.fromAttemptId !== previous.id || previous.submitAt)
          throw conflict(
            "Resolve the previous blocked or failed attempt through evidence-based recovery first.",
          );
      }
      const posting = objectValue(objectValue(record.details).posting);
      const postingContentHash =
        typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting);
      const manifest = {
        ...input.manifest,
        applicationEmailHash:
          objectValue(objectValue(record.details).applicationEmail).payloadHash ?? null,
        userPolicyHash: manifestHash(globalPolicy),
        settingsHash,
        recoveryRevision,
        postingContentHash,
        policy: { ...policy },
        canonicalUrl: url,
        ...requisition,
      };
      const attempt = await tx.personalAttempt.create({
        data: {
          recordId: record.id,
          userId,
          campaignId: input.campaignId,
          mode: input.mode,
          manifest: manifest as Prisma.InputJsonObject,
          manifestHash: manifestHash(manifest),
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          attemptNo: (previous?.attemptNo ?? 0) + 1,
          policyDay: day,
        },
      });
      await tx.personalReservation.create({
        data: { userId, identity: requisition.submissionIdentity, url, attemptId: attempt.id },
      });
      return attempt;
    });
  }

  async checkpoint(userId: string, id: string, lease: PersonalAttemptLeaseInput) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      if (!["preparing", "prepared"].includes(attempt.state))
        throw conflict("Only preparation leases can be renewed; reconcile any submission.");
      return tx.personalAttempt.update({
        where: { id },
        data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      });
    });
  }

  async prepare(userId: string, id: string, lease: PersonalAttemptLeaseInput) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      if (!["preparing", "prepared"].includes(attempt.state))
        throw conflict("Attempt cannot be prepared in this state.");
      if (attempt.mode === "submit")
        await this.verifyManifest(tx, userId, attempt.recordId, attempt.manifest);
      else await this.verifyDocument(userId, attempt.manifest);
      const result = await tx.personalAttempt.update({
        where: { id },
        data: { state: "prepared" },
      });
      if (attempt.mode === "submit")
        await tx.personalRecord.update({
          where: { id: attempt.recordId },
          data: { state: "prepared" },
        });
      return result;
    });
  }

  async freezeEmailTransport(
    userId: string,
    id: string,
    lease: PersonalAttemptLeaseInput,
    value: z.infer<typeof applicationEmailTransportFreezeSchema>,
  ) {
    const freeze = applicationEmailTransportFreezeSchema.parse(value);
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      if (
        attempt.mode !== "submit" ||
        attempt.state !== "prepared" ||
        attempt.submitAt ||
        freeze.dispatchStartedAt !== null
      )
        throw conflict("Email bytes must be frozen on a prepared pre-submit attempt");
      if (objectValue(attempt.receipt).emailTransport)
        throw conflict("Email transport is already frozen");
      await this.verifyManifest(tx, userId, attempt.recordId, attempt.manifest);
      const record = await tx.personalRecord.findFirstOrThrow({
        where: { id: attempt.recordId, userId },
      });
      const { to, subject, body, sourceQuote, sourceUrl } = freeze.payload;
      const payload = prepareApplicationEmail(
        { to, subject, body, sourceQuote, sourceUrl },
        record,
        freeze.payload.attachments,
      );
      if (
        payload.payloadHash !== freeze.payloadHash ||
        payload.payloadHash !== objectValue(attempt.manifest).applicationEmailHash ||
        objectValue(objectValue(record.details).applicationEmail).payloadHash !==
          payload.payloadHash ||
        manifestHash(payload) !== manifestHash(freeze.payload) ||
        freeze.messageId !== `<jobpilot-${id}@local.jobpilot>`
      )
        throw conflict("Email payload is not the frozen application draft");
      return tx.personalAttempt.update({
        where: { id },
        data: { receipt: { ...objectValue(attempt.receipt), emailTransport: freeze } },
      });
    });
  }

  async beginSubmit(userId: string, id: string, lease: PersonalAttemptLeaseInput) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      if (attempt.mode !== "submit" || attempt.state !== "prepared")
        throw conflict(
          "Only a prepared submit attempt may begin submission; submission attempts are never retried automatically.",
        );
      const campaign = await tx.campaign.findFirst({
        where: { userId, campaignId: attempt.campaignId, status: "in_progress" },
      });
      if (!campaign) throw conflict("Campaign is no longer active.");
      const policy = readAttemptPolicy(campaign.config);
      const frozen = (attempt.manifest as Prisma.JsonObject).policy;
      const globalPolicy = await userPolicy(tx, userId);
      if (objectValue(attempt.manifest).userPolicyHash !== manifestHash(globalPolicy))
        throw conflict("User policy changed; cancel and prepare a new attempt.");
      if (manifestHash(frozen) !== manifestHash(policy))
        throw conflict("Campaign policy changed; cancel and prepare a new attempt.");
      if (policyDay(policy.timezone) !== attempt.policyDay)
        throw conflict("Policy day changed; cancel and reserve under today's cap.");
      await tx.$queryRaw`SELECT id FROM personal_records WHERE id = ${attempt.recordId} AND user_id = ${userId} FOR UPDATE`;
      await this.verifyManifest(tx, userId, attempt.recordId, attempt.manifest);
      const record = await tx.personalRecord.findFirst({
        where: { id: attempt.recordId, userId, state: { in: ["eligible", "prepared"] } },
      });
      if (!record) throw conflict("Record is no longer eligible.");
      await enforceEmployerCap(
        tx,
        userId,
        await employerIdentity(tx, userId, record),
        globalPolicy.employerActiveCap,
        attempt.id,
      );
      if (policy.roleScope) {
        const reason = recordScopeParkReason(record, policy);
        if (reason) throw conflict(reason);
      }
      const frozenManifest = attempt.manifest as Prisma.JsonObject;
      if (
        (frozenManifest.applicationEmailHash ?? null) !==
        (objectValue(objectValue(record.details).applicationEmail).payloadHash ?? null)
      )
        throw conflict("Application email changed after reservation");
      const posting = objectValue(objectValue(record.details).posting);
      const postingContentHash =
        typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting);
      if (frozenManifest.postingContentHash !== postingContentHash)
        throw conflict(
          "Posting content changed after preparation; rebuild description-specific answers.",
        );
      if (frozenManifest.settingsHash !== manifestHash(await readSettings(userId)))
        throw conflict("Recruiting settings changed after preparation; prepare a new attempt.");
      const requisition = trustedRequisition(record, await employerIdentity(tx, userId, record));
      if (
        frozenManifest.requisitionId !== requisition.requisitionId ||
        frozenManifest.company !== requisition.company ||
        frozenManifest.submissionIdentity !== requisition.submissionIdentity ||
        frozenManifest.employerRequisitionKey !== requisition.employerRequisitionKey
      )
        throw conflict("Employer requisition changed after preparation.");
      if (
        canonicalizeJobUrl(record.url) !== frozenManifest.canonicalUrl ||
        record.identity !== frozenManifest.identity
      )
        throw conflict("Job identity changed after preparation.");
      if (
        await tx.application.findUnique({
          where: { userId_url: { userId, url: canonicalizeJobUrl(record.url) } },
        })
      )
        throw conflict("Already applied to this canonical URL.");
      const reservations = await this.jobReservations(
        tx,
        userId,
        record.identity,
        canonicalizeJobUrl(record.url),
        requisition.submissionIdentity,
        requisition.employerRequisitionKey,
      );
      if (!reservations.some((reservation) => reservation.attemptId === attempt.id))
        throw conflict("This attempt no longer owns its employer job reservation.");
      if (
        reservations.some(
          (reservation) =>
            reservation.attemptId !== attempt.id &&
            (reservation.attempt.submitAt ||
              ["submitting", "submitted", "submission_uncertain"].includes(
                reservation.attempt.state,
              ) ||
              (["preparing", "prepared"].includes(reservation.attempt.state) &&
                reservation.attempt.leaseExpiresAt > new Date())),
        )
      )
        throw conflict("Another submission reservation exists for this employer job.");
      await tx.personalRecord.update({
        where: { id: attempt.recordId },
        data: { state: "applying" },
      });
      return tx.personalAttempt.update({
        where: { id },
        data: { state: "submitting", submitAt: new Date() },
      });
    });
  }

  async receipt(
    userId: string,
    id: string,
    lease: PersonalAttemptLeaseInput,
    evidence: PersonalReceiptEvidence,
  ) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      return this.recordEvidence(tx, attempt, evidence);
    });
  }

  async reconcile(userId: string, id: string, evidence: PersonalReceiptEvidence) {
    return this.locked(userId, async (tx) =>
      this.recordEvidence(tx, await this.owned(tx, userId, id), evidence),
    );
  }

  async cancel(userId: string, id: string, lease: PersonalAttemptLeaseInput) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      if (attempt.submitAt || !["preparing", "prepared"].includes(attempt.state))
        throw conflict("A submission cannot be cancelled without reconciliation evidence.");
      const result = await tx.personalAttempt.update({
        where: { id },
        data: { state: "cancelled", leaseGeneration: { increment: 1 } },
      });
      await tx.personalReservation.deleteMany({ where: { attemptId: id, userId } });
      return result;
    });
  }

  async finishPreview(
    userId: string,
    id: string,
    lease: PersonalAttemptLeaseInput,
    expectedManifestHash: string,
  ) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      if (attempt.state === "previewed") {
        if (
          attempt.mode !== "offline" ||
          attempt.submitAt ||
          attempt.leaseOwner !== lease.leaseOwner ||
          attempt.manifestHash !== expectedManifestHash ||
          manifestHash(attempt.manifest) !== expectedManifestHash
        )
          throw conflict(
            "Completed preview replay does not match its owner and immutable manifest.",
          );
        return attempt;
      }
      this.requireLease(attempt, lease);
      if (attempt.mode !== "offline" || attempt.state !== "prepared" || attempt.submitAt)
        throw conflict("Only a prepared offline preview can finish without submission.");
      if (attempt.manifestHash !== expectedManifestHash)
        throw conflict("Preview manifest hash does not match.");
      const document = z
        .object({ path: z.string(), sha256: z.string() })
        .safeParse((attempt.manifest as Prisma.JsonObject).document);
      if (!document.success) throw conflict("Preview document is missing.");
      await verifyPrivateArtifact(
        document.data.path,
        document.data.sha256,
        privateArtifactRoot(userId),
      );
      const finished = await tx.personalAttempt.update({
        where: { id },
        data: {
          state: "previewed",
          receipt: {
            outcome: "previewed",
            manifestHash: attempt.manifestHash,
            completedAt: new Date().toISOString(),
          },
          leaseGeneration: { increment: 1 },
        },
      });
      await tx.personalReservation.deleteMany({ where: { userId, attemptId: id } });
      return finished;
    });
  }

  async park(
    userId: string,
    id: string,
    lease: PersonalAttemptLeaseInput,
    kind: "blocked" | "failed",
    reason: string,
  ) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.requireLease(attempt, lease);
      if (!["preparing", "prepared", "submitting", "submission_uncertain"].includes(attempt.state))
        throw conflict("Only an active attempt can be parked.");
      const state = attempt.submitAt ? "submission_uncertain" : kind;
      const parked = await tx.personalAttempt.update({
        where: { id },
        data: {
          state,
          receipt: {
            ...objectValue(attempt.receipt),
            outcome: state,
            reason,
            parkedAt: new Date().toISOString(),
            manifestHash: attempt.manifestHash,
          },
          leaseGeneration: { increment: 1 },
        },
      });
      await tx.personalRecord.update({ where: { id: attempt.recordId }, data: { state } });
      if (!attempt.submitAt)
        await tx.personalReservation.deleteMany({ where: { userId, attemptId: id } });
      return parked;
    });
  }

  private async owned(tx: Prisma.TransactionClient, userId: string, id: string) {
    const attempt = await tx.personalAttempt.findFirst({ where: { id, userId } });
    if (!attempt) throw notFound("Personal attempt not found");
    return attempt;
  }

  private requireLease(attempt: PersonalAttempt, lease: PersonalAttemptLeaseInput) {
    if (
      attempt.leaseOwner !== lease.leaseOwner ||
      attempt.leaseGeneration !== lease.leaseGeneration ||
      attempt.leaseExpiresAt <= new Date()
    )
      throw conflict("Lease is stale; do not submit. Reconcile any uncertain outcome.");
    if (manifestHash(attempt.manifest) !== attempt.manifestHash)
      throw conflict("Attempt manifest integrity check failed.");
  }

  private async expireSubmission(tx: Prisma.TransactionClient, attempt: PersonalAttempt) {
    if (attempt.state !== "submitting" || attempt.leaseExpiresAt > new Date()) return attempt;
    await tx.personalRecord.update({
      where: { id: attempt.recordId },
      data: { state: "submission_uncertain" },
    });
    return tx.personalAttempt.update({
      where: { id: attempt.id },
      data: { state: "submission_uncertain", leaseGeneration: { increment: 1 } },
    });
  }

  private async jobReservations(
    tx: Prisma.TransactionClient,
    userId: string,
    postingIdentity: string,
    url: string,
    submissionIdentity: string,
    employerRequisitionKey: string | null,
  ) {
    // Include historical native-post reservations without rewriting their immutable ledger.
    const reservations = await tx.personalReservation.findMany({
      where: { userId },
      include: { attempt: { include: { record: true } } },
    });
    const matches = [];
    for (const reservation of reservations) {
      if (reservation.attempt.userId !== userId || reservation.attempt.record.userId !== userId)
        continue;
      const frozen = objectValue(reservation.attempt.manifest);
      if (
        reservation.identity === submissionIdentity ||
        reservation.identity === postingIdentity ||
        reservation.url === url ||
        frozen.submissionIdentity === submissionIdentity ||
        (employerRequisitionKey && frozen.employerRequisitionKey === employerRequisitionKey)
      ) {
        matches.push(reservation);
        continue;
      }
      try {
        const other = trustedRequisition(
          reservation.attempt.record,
          await employerIdentity(tx, userId, reservation.attempt.record),
        );
        if (
          other.submissionIdentity === submissionIdentity ||
          (employerRequisitionKey && other.employerRequisitionKey === employerRequisitionKey)
        )
          matches.push(reservation);
      } catch {
        // Frozen identities above still protect history if the current record is invalid.
      }
    }
    return matches;
  }

  private async checkCaps(
    tx: Prisma.TransactionClient,
    userId: string,
    campaignId: string,
    policy: ReturnType<typeof readAttemptPolicy>,
    day: string,
    mode: PersonalAttemptStartInput["mode"],
  ) {
    const base = { userId, mode, state: { in: [...RESERVED_STATES] } };
    const daily = await tx.personalAttempt.count({
      where: {
        ...base,
        OR: [{ policyDay: day }, { state: { in: ["submitting", "submission_uncertain"] } }],
      },
    });
    const total = await tx.personalAttempt.count({ where: { ...base, campaignId } });
    const globalPolicy = await userPolicy(tx, userId);
    if (
      daily >= Math.min(policy.dailyCap, globalPolicy.dailyCap) ||
      total >= policy.maxApplications
    )
      throw conflict(
        "Personal application cap reached, including reserved and unresolved submissions.",
      );
  }

  private async verifyDocument(userId: string, manifest: unknown) {
    const parsed = z
      .object({
        recordId: z.uuid(),
        document: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      })
      .safeParse(manifest);
    if (!parsed.success)
      throw conflict("A hashed private document is required for every attempt mode.");
    const record = await this.prisma.personalRecord.findFirst({
      where: { id: parsed.data.recordId, userId },
    });
    if (!record) throw notFound("Owned personal record not found");
    const evidence = await this.prisma.personalResumeEvidence.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    validateManifestScreeningSources(manifest, record, await readSettings(userId), evidence);
    await verifyAttachmentManifest(this.prisma, userId, record, manifest, false);
    await verifyPrivateArtifact(
      parsed.data.document.path,
      parsed.data.document.sha256,
      privateArtifactRoot(userId),
    );
  }

  async verifyContinuationManifest(
    tx: Prisma.TransactionClient,
    userId: string,
    attempt: PersonalAttempt,
  ) {
    if (
      attempt.userId !== userId ||
      attempt.mode !== "submit" ||
      !attempt.submitAt ||
      !["submitting", "submission_uncertain"].includes(attempt.state) ||
      manifestHash(attempt.manifest) !== attempt.manifestHash
    )
      throw conflict("Continuation requires the original unresolved submit attempt.");
    const campaign = await tx.campaign.findFirst({
      where: { userId, campaignId: attempt.campaignId, status: "in_progress" },
    });
    if (!campaign) throw conflict("Campaign is no longer active.");
    const policy = readAttemptPolicy(campaign.config);
    const frozen = objectValue(attempt.manifest);
    if (frozen.userPolicyHash !== manifestHash(await userPolicy(tx, userId)))
      throw conflict("User policy changed; submission continuation is held.");
    if (manifestHash(frozen.policy) !== manifestHash(policy))
      throw conflict("Campaign policy changed after submission.");
    const currentRun = objectValue(
      objectValue(objectValue(campaign.config).personal).authorization,
    ).runId;
    if (frozen.campaignRunId && currentRun !== frozen.campaignRunId)
      throw conflict("Campaign authorization changed after submission.");
    await tx.$queryRaw`SELECT id FROM personal_records WHERE id = ${attempt.recordId} AND user_id = ${userId} FOR UPDATE`;
    const record = await tx.personalRecord.findFirst({ where: { id: attempt.recordId, userId } });
    if (!record || !["applying", "submission_uncertain"].includes(record.state))
      throw conflict("Record is no longer held for this submission.");
    await enforceEmployerCap(
      tx,
      userId,
      await employerIdentity(tx, userId, record),
      (await userPolicy(tx, userId)).employerActiveCap,
      attempt.id,
    );
    const posting = objectValue(objectValue(record.details).posting);
    const contentHash =
      typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting);
    const requisition = trustedRequisition(record, await employerIdentity(tx, userId, record));
    if (
      frozen.postingContentHash !== contentHash ||
      frozen.settingsHash !== manifestHash(await readSettings(userId)) ||
      frozen.identity !== record.identity ||
      frozen.canonicalUrl !== canonicalizeJobUrl(record.url) ||
      frozen.submissionIdentity !== requisition.submissionIdentity ||
      frozen.employerRequisitionKey !== requisition.employerRequisitionKey ||
      frozen.requisitionId !== requisition.requisitionId ||
      frozen.company !== requisition.company
    )
      throw conflict("Submission source, identity or settings changed; continuation is held.");
    if (policy.roleScope) {
      const reason = recordScopeParkReason(record, policy);
      if (reason) throw conflict(reason);
    }
    const reservation = await tx.personalReservation.findFirst({
      where: { userId, attemptId: attempt.id },
    });
    if (!reservation) throw conflict("Submission reservation is unavailable.");
    await this.verifyManifest(tx, userId, attempt.recordId, attempt.manifest);
  }

  private async verifyManifest(
    tx: Prisma.TransactionClient,
    userId: string,
    recordId: string,
    manifest: unknown,
  ) {
    const parsed = submitManifestSchema.safeParse(manifest);
    if (!parsed.success || parsed.data.recordId !== recordId)
      throw conflict(
        "Submit requires a ready document, complete answers, and eligible immutable manifest.",
      );
    const evidence = await tx.personalResumeEvidence.findFirst({
      where: { id: parsed.data.resumeEvidenceId, userId, sourceHash: parsed.data.sourceHash },
    });
    if (!evidence) throw conflict("Verified owned resume evidence does not match the manifest.");
    const latestEvidence = await tx.personalResumeEvidence.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (latestEvidence?.id !== evidence.id)
      throw conflict(
        "Resume evidence changed after preparation; authorize the current facts before submitting.",
      );
    const record = await tx.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Owned personal record not found");
    const seniorityReason = seniorityParkReason(record);
    if (seniorityReason) throw conflict(seniorityReason);
    const settings = await readSettings(userId);
    if (!settings.recruitingAvailability)
      throw conflict("Approved recruiting availability is required before submission.");
    verifyRecruitingConstraints(record, settings, evidence);
    validateManifestScreeningSources(manifest, record, await readSettings(userId), evidence);
    const savedAdjudication = objectValue(record.details).eligibilityAdjudication;
    const adjudication = objectValue(savedAdjudication);
    if (
      savedAdjudication !== undefined &&
      !sameRecoveryContext(
        adjudication.context ?? null,
        recoveryContext(record, await readSettings(userId), evidence),
      )
    )
      throw conflict(
        "Eligibility adjudication is stale; adjudicate the current posting, settings, and resume evidence before submitting",
      );
    let resumeDataHash: string | undefined;
    if (
      Array.isArray(objectValue(record.details).attachments) &&
      (objectValue(record.details).attachments as unknown[]).length
    ) {
      const resume = await tx.resume.findFirst({ where: { id: evidence.resumeId, userId } });
      if (!resume?.content) throw conflict("Attachment resume document is unavailable");
      resumeDataHash = manifestHash(resumeDataSchema.parse(JSON.parse(resume.content)));
    }
    await verifyAttachmentManifest(tx, userId, record, manifest, true, {
      ...evidence,
      resumeDataHash,
    });
    const readiness = z
      .object({
        eligibility: z.object({ decision: z.literal("eligible") }),
        missingAnswers: z.array(z.string()).length(0),
        preview: z.object({
          readiness: z.literal("ready"),
          conflicts: z.array(z.string()).length(0),
          renderReviewed: z.literal(true),
          pdfHash: z.literal(parsed.data.document.sha256),
        }),
      })
      .safeParse(record?.details);
    const resumeReady = z
      .object({ conflicts: z.array(z.string()).length(0) })
      .safeParse(evidence.details);
    if (!readiness.success || !resumeReady.success)
      throw conflict(
        "Persisted eligibility, answers, document review, and resume evidence must all be ready.",
      );
    // Retain specific identity and frozen-fact diagnostics before the general freshness hold.
    trustedRequisition(record);
    const settingsHash = objectValue(manifest).settingsHash;
    if (typeof settingsHash === "string" && settingsHash !== manifestHash(settings))
      throw conflict("Recruiting settings changed after preparation; prepare a new attempt.");
    const freshness = eligibilityFreshness(record, { settings, evidence });
    if (freshness.status !== "current") throw conflict(freshness.reason!);
    await verifyPrivateArtifact(
      parsed.data.document.path,
      parsed.data.document.sha256,
      privateArtifactRoot(userId),
    );
  }

  private async recordEvidence(
    tx: Prisma.TransactionClient,
    attempt: PersonalAttempt,
    evidence: PersonalReceiptEvidence,
  ) {
    if (!attempt.submitAt || !["submitting", "submission_uncertain"].includes(attempt.state))
      throw conflict("Only an unresolved submission accepts reconciliation evidence.");
    if (
      attempt.manifestHash !== evidence.manifestHash ||
      manifestHash(attempt.manifest) !== attempt.manifestHash
    )
      throw conflict("Receipt does not match the immutable manifest.");
    if (
      new Date(evidence.capturedAt) < attempt.submitAt ||
      new Date(evidence.capturedAt).getTime() > Date.now() + 60_000
    )
      throw conflict("Receipt capture time must follow the submit boundary.");
    if (evidence.outcome === "submitted" && evidence.kind === "manual_review")
      throw conflict("Submitted requires an employer confirmation artifact.");
    await verifyPrivateArtifact(
      evidence.artifactPath,
      evidence.sha256,
      privateArtifactRoot(attempt.userId),
    );
    const emailTransport = objectValue(attempt.receipt).emailTransport;
    const hostedTransport = objectValue(attempt.receipt).hostedTransport;
    if (hostedTransport && evidence.outcome === "not_submitted")
      throw conflict(
        "Frozen hosted submission remains reserved until correlated reconciliation; a missing confirmation cannot release it",
      );
    if (emailTransport && evidence.outcome === "not_submitted")
      throw conflict(
        "Email submit intent remains reserved; absence from Sent is not proof of non-submission",
      );
    if (
      emailTransport &&
      evidence.outcome === "submitted" &&
      evidence.kind !== "confirmation_email"
    )
      throw conflict(
        "Application email requires an employer acknowledgment, not provider acceptance",
      );
    const challengeLedger = objectValue(attempt.receipt).challengeLedger;
    if (challengeLedger && evidence.outcome === "submitted") {
      let artifact: unknown;
      try {
        const bytes = await readPrivateArtifact(
          evidence.artifactPath,
          privateArtifactRoot(attempt.userId),
        );
        if (sha256(bytes) !== evidence.sha256)
          throw new Error("Receipt changed during verification");
        artifact = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw conflict(
          "Pinned submission acceptance requires a private correlated transport receipt.",
        );
      }
      validateChallengeAcceptance(challengeLedger, attempt, artifact, evidence);
    }
    if (challengeLedger && evidence.outcome === "not_submitted")
      throw conflict(
        "A frozen post-submit transport remains held; challenge nonacceptance never authorizes a new application attempt.",
      );
    const state =
      evidence.outcome === "uncertain"
        ? "submission_uncertain"
        : evidence.outcome === "submitted"
          ? "submitted"
          : "cancelled";
    const result = await tx.personalAttempt.update({
      where: { id: attempt.id },
      data: {
        state,
        receipt: {
          ...objectValue(attempt.receipt),
          ...evidence,
          ...(challengeLedger ? { challengeLedger } : {}),
          ...(emailTransport ? { emailTransport } : {}),
        } as Prisma.InputJsonValue,
        leaseGeneration: { increment: 1 },
      },
    });
    await tx.personalRecord.update({
      where: { id: attempt.recordId },
      data: {
        state:
          evidence.outcome === "not_submitted"
            ? "eligible"
            : state === "submitted"
              ? "submitted"
              : "submission_uncertain",
      },
    });
    if (evidence.outcome === "not_submitted")
      await tx.personalReservation.deleteMany({ where: { attemptId: attempt.id } });
    return result;
  }
}
