import { frozenApplicationEmailSchema } from "@jobpilot/contracts/personal-application-email";
import {
  personalApprovalPacketSchema,
  personalApprovalReceiptSchema,
} from "@jobpilot/contracts/personal-approval";
import { personalAttemptReconcileSchema } from "@jobpilot/contracts/personal-attempt";
import {
  type PersonalFollowupObservation,
  personalFollowupResponseSchema,
} from "@jobpilot/contracts/personal-followups";
import { singleton } from "tsyringe";
import { z } from "zod/v4";
import { conflict, notFound } from "@/common/errors";
import { type PersonalAttempt, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { canonicalizeJobUrl } from "@/modules/application/job-url";
import {
  manifestHash,
  privateArtifactRoot,
  readPrivateArtifact,
  verifyPrivateArtifact,
} from "../persistence-policy";
import { jsonValue, objectValue } from "../runtime";
import {
  createFollowupDraft,
  followupDrafts,
  followupEligibility,
  followupHistory,
  type SubmittedMaterials,
  verifyFollowupMessage,
} from "./policy";

const documentSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });

@singleton()
export class PersonalFollowupService {
  constructor(private readonly prisma: PrismaClient) {}

  private lock<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(
      async (tx) => {
        const users = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!users.length) throw notFound("User not found");
        return work(tx);
      },
      { timeout: 15_000 },
    );
  }

  private async submitted(
    userId: string,
    recordId: string,
    attempt: PersonalAttempt,
  ): Promise<SubmittedMaterials & { destination: string }> {
    if (
      attempt.state !== "submitted" ||
      attempt.mode !== "submit" ||
      !attempt.submitAt ||
      manifestHash(attempt.manifest) !== attempt.manifestHash
    )
      throw conflict("A confirmed frozen submission is required");
    const manifest = objectValue(attempt.manifest);
    const receipt = personalAttemptReconcileSchema.parse({ evidence: attempt.receipt }).evidence;
    if (
      receipt.outcome !== "submitted" ||
      receipt.manifestHash !== attempt.manifestHash ||
      manifest.recordId !== recordId
    )
      throw conflict("Submission receipt does not match the frozen application");
    const document = documentSchema.parse(manifest.document);
    const approval = personalApprovalReceiptSchema.parse(manifest.applicationApproval);
    const root = privateArtifactRoot(userId);
    await Promise.all([
      verifyPrivateArtifact(document.path, document.sha256, root),
      verifyPrivateArtifact(receipt.artifactPath, receipt.sha256, root),
      verifyPrivateArtifact(approval.packetArtifact.path, approval.packetArtifact.sha256, root),
    ]);
    const bytes = await readPrivateArtifact(approval.packetArtifact.path, root);
    const packet = personalApprovalPacketSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      manifestHash(packet) !== approval.packetHash ||
      packet.recordId !== recordId ||
      objectValue(packet.preparedManifest.document).sha256 !== document.sha256
    )
      throw conflict("Approved packet does not match the submitted materials");
    const email = frozenApplicationEmailSchema.safeParse(packet.evidence.applicationEmail);
    return {
      attemptId: attempt.id,
      manifestHash: attempt.manifestHash,
      documentSha256: document.sha256,
      receiptSha256: receipt.sha256,
      packetHash: approval.packetHash,
      title: packet.title,
      company: packet.company,
      submittedAt: attempt.submitAt,
      recipient: email.success ? email.data.to : null,
      destination: packet.destination,
    };
  }

  private async context(tx: Prisma.TransactionClient, userId: string, recordId: string, now: Date) {
    const record = await tx.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const history = followupHistory(objectValue(record.details).followups);
    const attempt = await tx.personalAttempt.findFirst({
      where: { recordId, userId, mode: "submit" },
      orderBy: { attemptNo: "desc" },
    });
    let submission: (SubmittedMaterials & { destination: string }) | null = null;
    if (attempt && record.state === "submitted") {
      try {
        submission = await this.submitted(userId, recordId, attempt);
      } catch {
        /* Missing historical evidence holds new drafting. */
      }
    }
    const application = submission
      ? await tx.application.findFirst({
          where: {
            userId,
            url: { in: [submission.destination, canonicalizeJobUrl(submission.destination)] },
          },
          select: { id: true, status: true },
        })
      : null;
    let lastActivityAt: Date | null = null;
    if (application) {
      const [emails, events, networking] = await Promise.all([
        tx.emailMessage.aggregate({
          where: { account: { userId }, matchedAppId: application.id },
          _max: { receivedAt: true },
        }),
        tx.applicationEvent.aggregate({
          where: { applicationId: application.id },
          _max: { createdAt: true },
        }),
        tx.networkingMessage.aggregate({
          where: { userId, contact: { userId, relatedAppId: application.id } },
          _max: { sentAt: true, repliedAt: true },
        }),
      ]);
      const activity = [
        emails._max.receivedAt,
        events._max.createdAt,
        networking._max.sentAt,
        networking._max.repliedAt,
      ].filter((date): date is Date => date !== null);
      if (activity.length)
        lastActivityAt = new Date(Math.max(...activity.map((date) => date.getTime())));
    }
    const eligibility = followupEligibility({
      history,
      submission,
      recordState: record.state,
      applicationStatus: application?.status ?? null,
      lastActivityAt,
      now,
    });
    const recordVersion = manifestHash({
      updatedAt: record.updatedAt.toISOString(),
      history,
      attemptHash: attempt?.manifestHash ?? null,
      applicationStatus: application?.status ?? null,
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
    });
    const response = personalFollowupResponseSchema.parse({
      recordId,
      recordVersion,
      ...eligibility,
      quietDays: 10,
      maximumDrafts: 2,
      drafts: followupDrafts(history),
    });
    return { record, history, submission, application, response };
  }

  async get(userId: string, recordId: string, now = new Date()) {
    return this.lock(
      userId,
      async (tx) => (await this.context(tx, userId, recordId, now)).response,
    );
  }

  async draft(userId: string, recordId: string, expectedVersion: string, now = new Date()) {
    return this.lock(userId, async (tx) => {
      const context = await this.context(tx, userId, recordId, now);
      if (context.response.recordVersion !== expectedVersion)
        throw conflict("Application activity changed; refresh follow-up evidence");
      if (!context.response.eligible || !context.submission)
        throw conflict(context.response.blocker ?? "Follow-up is not ready");
      const ordinal = (context.response.drafts.length + 1) as 1 | 2;
      const event = createFollowupDraft(context.submission, ordinal, now);
      const updated = await tx.personalRecord.updateMany({
        where: {
          id: recordId,
          userId,
          updatedAt: context.record.updatedAt,
          details: { equals: jsonValue(context.record.details) },
          state: "submitted",
        },
        data: {
          details: jsonValue({
            ...objectValue(context.record.details),
            followups: [...context.history, event],
          }),
        },
      });
      if (updated.count !== 1) throw conflict("Application changed while preparing the draft");
      return (await this.context(tx, userId, recordId, now)).response;
    });
  }

  async observe(
    userId: string,
    recordId: string,
    input: PersonalFollowupObservation,
    now = new Date(),
  ) {
    return this.lock(userId, async (tx) => {
      const context = await this.context(tx, userId, recordId, now);
      if (context.response.recordVersion !== input.recordVersion)
        throw conflict("Application activity changed; refresh follow-up evidence");
      const draft = context.response.drafts.find((item) => item.id === input.draftId);
      if (!draft || !context.application || !context.submission)
        throw conflict("Draft and confirmed application evidence are required");
      if (
        draft.status === "employer_confirmed" ||
        (draft.status === "sent" && input.kind !== "employer_confirmed")
      )
        throw conflict("A recorded delivery outcome cannot be downgraded");
      const value = await tx.networkingMessage.findFirst({
        where: { id: input.networkingMessageId, userId },
        include: { contact: true },
      });
      let message: ReturnType<typeof verifyFollowupMessage>;
      try {
        message = verifyFollowupMessage(
          value,
          userId,
          context.application.id,
          draft,
          input.kind,
          now,
        );
      } catch {
        throw conflict(
          "Existing outbound evidence does not prove this exact follow-up transmission",
        );
      }
      let emailMessageId: string | null = null;
      let at = message.sentAt ?? now;
      let replyEvidence: unknown = null;
      if (input.kind === "employer_confirmed") {
        const reply = await tx.emailMessage.findFirst({
          where: {
            id: input.emailMessageId,
            account: { userId },
            matchedAppId: context.application.id,
          },
        });
        if (
          !reply ||
          !message.threadId ||
          reply.threadId !== message.threadId ||
          reply.fromAddress.toLowerCase() !== draft.recipient?.toLowerCase() ||
          !["approved", "auto"].includes(reply.reviewStatus) ||
          reply.receivedAt < at ||
          reply.receivedAt > now ||
          reply.classification === "irrelevant" ||
          reply.classification === "verification"
        )
          throw conflict("Employer confirmation requires a reviewed correlated inbound reply");
        emailMessageId = reply.id;
        at = reply.receivedAt;
        replyEvidence = {
          id: reply.id,
          providerId: reply.providerId,
          threadId: reply.threadId,
          receivedAt: at.toISOString(),
        };
      }
      const evidenceHash = manifestHash({
        messageId: message.id,
        providerId: message.providerId,
        status: message.status,
        subject: message.subject,
        body: message.body,
        recipient: draft.recipient,
        at: at.toISOString(),
        replyEvidence,
      });
      if (
        context.history.some(
          (event) =>
            event.kind !== "drafted" &&
            event.evidenceHash === evidenceHash &&
            event.kind === input.kind,
        )
      )
        return context.response;
      const history = followupHistory([
        ...context.history,
        {
          kind: input.kind,
          draftId: draft.id,
          at: at.toISOString(),
          networkingMessageId: message.id,
          emailMessageId,
          providerId: message.providerId,
          evidenceHash,
        },
      ]);
      const updated = await tx.personalRecord.updateMany({
        where: {
          id: recordId,
          userId,
          updatedAt: context.record.updatedAt,
          details: { equals: jsonValue(context.record.details) },
          state: "submitted",
        },
        data: {
          details: jsonValue({ ...objectValue(context.record.details), followups: history }),
        },
      });
      if (updated.count !== 1)
        throw conflict("Application changed while recording existing evidence");
      return (await this.context(tx, userId, recordId, now)).response;
    });
  }
}
