import { randomUUID } from "node:crypto";
import {
  type ApplicationEmailAttachment,
  applicationEmailTransportFreezeSchema,
  frozenApplicationEmailSchema,
} from "@jobpilot/contracts/personal-application-email";
import {
  type PersonalApplicationEmailPrepareInput,
  personalApplicationEmailDraftResponseSchema,
  personalApplicationEmailResultSchema,
} from "@jobpilot/contracts/personal-application-email-control";
import type { PersonalAttemptLeaseInput } from "@jobpilot/contracts/personal-attempt";
import { singleton } from "tsyringe";
import { conflict, notFound } from "@/common/errors";
import { type PersonalAttempt, type PersonalRecord, PrismaClient } from "@/generated/prisma/client";
import { buildApplicationEmailMime } from "./application-email/mime";
import { prepareApplicationEmail } from "./application-email/policy";
import { ApplicationEmailTransportService } from "./application-email/transport.service";
import { PersonalAttemptService } from "./attempt.service";
import { privateArtifactRoot, readPrivateArtifact } from "./persistence-policy";
import { jsonValue, objectValue, sha256, textValue } from "./runtime";

@singleton()
export class PersonalApplicationEmailService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly attempts: PersonalAttemptService,
    private readonly transport: ApplicationEmailTransportService,
  ) {}

  protected readPdf(userId: string, path: string): Promise<Buffer> {
    return readPrivateArtifact(path, privateArtifactRoot(userId));
  }

  private async attachments(userId: string, record: PersonalRecord) {
    const details = objectValue(record.details);
    const document = objectValue(details.document);
    const frozen = objectValue(details.previewAttachments).attachments;
    const sources = [
      { kind: "resume" as const, filename: "resume.pdf", source: document },
      ...(Array.isArray(frozen) ? frozen : []).map((value, index) => ({
        kind: "cover_letter" as const,
        filename: `cover-letter-${index + 1}.pdf`,
        source: objectValue(value),
      })),
    ];
    if (sources.length > 5) throw conflict("Too many application PDF attachments.");
    const bytes: Buffer[] = [];
    const metadata: ApplicationEmailAttachment[] = [];
    for (const item of sources) {
      if (typeof item.source.path !== "string" || typeof item.source.sha256 !== "string")
        throw conflict("Current frozen application PDF is unavailable.");
      const pdf = await this.readPdf(userId, item.source.path);
      if (sha256(pdf) !== item.source.sha256 || pdf.subarray(0, 5).toString() !== "%PDF-")
        throw conflict("Application PDF bytes changed since review.");
      bytes.push(pdf);
      metadata.push({
        kind: item.kind,
        filename: item.filename,
        mimeType: "application/pdf",
        sha256: item.source.sha256,
        bytes: pdf.length,
      });
    }
    return { bytes, metadata };
  }

  async prepare(userId: string, recordId: string, input: PersonalApplicationEmailPrepareInput) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Owned personal record not found");
    if (record.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime())
      throw conflict("Record changed; reload before preparing the application email.");
    const { expectedUpdatedAt: _expected, ...message } = input;
    const files = await this.attachments(userId, record);
    const payload = prepareApplicationEmail(message, record, files.metadata);
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const owners = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!owners.length) throw notFound("Application owner not found");
        await tx.$queryRaw`SELECT id FROM personal_records WHERE id = ${recordId} AND user_id = ${userId} FOR UPDATE`;
        const current = await tx.personalRecord.findFirst({ where: { id: recordId, userId } });
        if (
          !current ||
          current.updatedAt.getTime() !== record.updatedAt.getTime() ||
          ["applying", "submitted", "submission_uncertain"].includes(current.state)
        )
          throw conflict(
            "An active, changed, or submitted record cannot replace its application email.",
          );
        const active = await tx.personalAttempt.findFirst({
          where: {
            userId,
            recordId,
            OR: [
              {
                state: {
                  in: ["preparing", "prepared", "submitting", "submitted", "submission_uncertain"],
                },
              },
              { submitAt: { not: null } },
            ],
          },
          select: { id: true },
        });
        if (active)
          throw conflict("Cancel the preparation lease before replacing its email draft.");
        const details = objectValue(current.details);
        const history = Array.isArray(details.applicationEmailHistory)
          ? details.applicationEmailHistory
          : [];
        const saved = await tx.personalRecord.updateMany({
          where: { id: recordId, userId, updatedAt: current.updatedAt },
          data: {
            details: jsonValue({
              ...details,
              applicationEmail: payload,
              applicationEmailHistory: [
                ...history,
                { payload, createdAt: new Date().toISOString(), preparedBy: userId },
              ],
            }),
          },
        });
        if (saved.count !== 1) throw conflict("Record changed while saving the email draft.");
        const result = await tx.personalRecord.findFirst({ where: { id: recordId, userId } });
        if (!result) throw notFound("Owned personal record not found");
        return result;
      },
      { timeout: 15000 },
    );
    return personalApplicationEmailDraftResponseSchema.parse({
      recordId,
      updatedAt: updated.updatedAt,
      payload,
    });
  }

  async dispatch(userId: string, attemptId: string, lease: PersonalAttemptLeaseInput) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (
      attempt.mode !== "submit" ||
      attempt.state !== "prepared" ||
      attempt.submitAt ||
      attempt.leaseOwner !== lease.leaseOwner ||
      attempt.leaseGeneration !== lease.leaseGeneration
    )
      throw conflict("Only the current prepared submit lease can dispatch an application email.");
    const preflight = await this.transport.preflight(userId);
    if (preflight.status === "blocked") return this.result(attempt, preflight);
    const record = await this.prisma.personalRecord.findFirst({
      where: { id: attempt.recordId, userId },
    });
    if (!record) throw notFound("Owned personal record not found");
    const saved = frozenApplicationEmailSchema.parse(objectValue(record.details).applicationEmail);
    if (objectValue(attempt.manifest).applicationEmailHash !== saved.payloadHash)
      throw conflict("Application email changed after the attempt was reserved.");
    const files = await this.attachments(userId, record);
    const { to, subject, body, sourceQuote, sourceUrl } = saved;
    const payload = prepareApplicationEmail(
      { to, subject, body, sourceQuote, sourceUrl },
      record,
      files.metadata,
    );
    if (payload.payloadHash !== saved.payloadHash)
      throw conflict("Application email source or documents changed.");
    const prepared = buildApplicationEmailMime(attemptId, preflight.from, payload, files.bytes);
    const frozen = applicationEmailTransportFreezeSchema.parse({
      schemaVersion: 1,
      state: "claimed",
      claimId: randomUUID(),
      payloadHash: payload.payloadHash,
      mimeHash: prepared.mimeHash,
      messageId: prepared.messageId,
      from: preflight.from,
      dispatchStartedAt: null,
      payload,
      proof: prepared.proof,
    });
    await this.attempts.freezeEmailTransport(userId, attemptId, lease, frozen);
    await this.attempts.beginSubmit(userId, attemptId, lease);
    let provider: Record<string, unknown>;
    try {
      provider = await this.transport.sendPrepared(userId, attemptId, prepared);
    } catch {
      provider = {
        status: "uncertain",
        reason:
          "The submission boundary was crossed without a final email receipt. Reconcile this attempt before continuing.",
        employerAcknowledged: false,
        canResend: false,
      };
    }
    return this.saveProviderReceipt(userId, attemptId, provider);
  }

  async reconcileEmail(userId: string, attemptId: string) {
    await this.ownedAttempt(userId, attemptId);
    const provider = await this.transport.lookupSent(userId, attemptId);
    return this.saveProviderReceipt(userId, attemptId, provider);
  }

  private async ownedAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.personalAttempt.findFirst({
      where: { id: attemptId, userId },
    });
    if (!attempt) throw notFound("Owned application attempt not found");
    return attempt;
  }

  private async saveProviderReceipt(
    userId: string,
    attemptId: string,
    provider: Record<string, unknown>,
  ) {
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const owners = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!owners.length) throw notFound("Application owner not found");
        const attempt = await tx.personalAttempt.findFirst({ where: { id: attemptId, userId } });
        if (
          !attempt?.submitAt ||
          !["submitting", "submission_uncertain", "submitted"].includes(attempt.state)
        )
          throw conflict("A begun application attempt is required for email receipt evidence.");
        const old = objectValue(attempt.receipt);
        const history = Array.isArray(old.emailProviderReceiptHistory)
          ? old.emailProviderReceiptHistory
          : [];
        const receipt = {
          ...old,
          emailProviderReceipt: provider,
          emailProviderReceiptHistory: [
            ...history,
            { ...provider, capturedAt: new Date().toISOString() },
          ],
        };
        const state = attempt.state === "submitted" ? "submitted" : "submission_uncertain";
        const saved = await tx.personalAttempt.updateMany({
          where: { id: attemptId, userId, updatedAt: attempt.updatedAt },
          data: { state, receipt: jsonValue(receipt) },
        });
        if (saved.count !== 1)
          throw conflict(
            "Attempt changed while recording the provider receipt; reconcile it again.",
          );
        if (state !== "submitted")
          await tx.personalRecord.updateMany({
            where: { id: attempt.recordId, userId, state: { not: "submitted" } },
            data: { state },
          });
        const result = await tx.personalAttempt.findFirst({ where: { id: attemptId, userId } });
        if (!result) throw notFound("Owned application attempt not found");
        return result;
      },
      { timeout: 15000 },
    );
    return this.result(updated, provider);
  }

  private result(attempt: PersonalAttempt, provider: Record<string, unknown>) {
    const frozen = objectValue(objectValue(attempt.receipt).emailTransport);
    return personalApplicationEmailResultSchema.parse({
      attemptId: attempt.id,
      attemptState: attempt.state,
      updatedAt: attempt.updatedAt,
      status: provider.status,
      reason: textValue(provider.reason) || null,
      providerMessageId: textValue(provider.providerMessageId) || null,
      threadId: textValue(provider.threadId) || null,
      payloadHash: textValue(provider.payloadHash) || textValue(frozen.payloadHash) || null,
      mimeHash: textValue(provider.mimeHash) || textValue(frozen.mimeHash) || null,
      messageId: textValue(provider.messageId) || textValue(frozen.messageId) || null,
      employerAcknowledged: false,
      canResend: false,
    });
  }
}
