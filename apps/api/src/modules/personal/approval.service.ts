import {
  type PersonalApprovalInput,
  type PersonalApprovalPacket,
  type PersonalApprovalReceipt,
  personalApprovalResponseSchema,
} from "@jobpilot/contracts/personal-approval";
import { singleton } from "tsyringe";
import { conflict, HttpError, notFound } from "@/common/errors";
import { env } from "@/env";
import { type Prisma, PrismaClient } from "@/generated/prisma/client";
import { buildApprovalPacket, saveApprovalPacket } from "./approval-packet";
import {
  approvalExpiry,
  approvalHistory,
  approvalNonce,
  verifyApprovalNonce,
} from "./approval-policy";
import { PersonalAttemptService } from "./attempt.service";
import { recordScopeParkReason } from "./campaign-policy";
import { manifestHash, readAttemptPolicy } from "./persistence-policy";
import { jsonValue, objectValue } from "./runtime";

@singleton()
export class PersonalApprovalService {
  constructor(
    private readonly prisma: PrismaClient,
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
      { timeout: 15_000 },
    );
  }

  private async review(
    tx: Prisma.TransactionClient,
    userId: string,
    recordId: string,
    session: string,
  ) {
    const record = await tx.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Personal record not found");
    const blockers: string[] = [];
    let packet: PersonalApprovalPacket | null = null;
    const campaigns = await tx.campaign.findMany({
      where: {
        userId,
        status: "in_progress",
        config: { path: ["personal", "enabled"], equals: true },
      },
      orderBy: { updatedAt: "desc" },
    });
    // Use the most recently launched matching campaign; the exact run is visible in the packet.
    const campaign = campaigns.find((item) => {
      try {
        const policy = readAttemptPolicy(item.config);
        return policy.mode !== "offline" && !recordScopeParkReason(record, policy);
      } catch {
        return false;
      }
    });
    if (!campaign)
      blockers.push("Launch a matching live campaign before reviewing this application");
    else {
      try {
        packet = await buildApprovalPacket(tx, userId, record, campaign);
        await this.attempts.verifyApprovalReadiness(tx, userId, record.id, packet.preparedManifest);
        if (!["eligible", "prepared"].includes(record.state))
          blockers.push(
            "This application is already submitted, unresolved, or requires preparation",
          );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        blockers.push(error.message);
      }
    }
    const packetHash = manifestHash(packet);
    const events = approvalHistory(objectValue(record.details));
    const latest = [...events].reverse().find((event) => event.kind === "approved");
    let approval = null;
    if (latest?.kind === "approved") {
      const receipt = latest.receipt;
      const binding = events.find(
        (event) => event.kind === "bound" && event.approvalId === receipt.id,
      );
      let status: "approved" | "bound" | "withdrawn" | "expired" | "stale" = "approved";
      if (binding) status = "bound";
      if (receipt.packetHash !== packetHash) status = "stale";
      if (Date.parse(receipt.expiresAt) <= Date.now()) status = "expired";
      if (events.some((event) => event.kind === "withdrawn" && event.approvalId === receipt.id))
        status = "withdrawn";
      approval = {
        id: receipt.id,
        status,
        approvedAt: new Date(receipt.approvedAt),
        expiresAt: new Date(receipt.expiresAt),
        attemptId: binding?.kind === "bound" ? binding.attemptId : null,
      };
    }
    return {
      record,
      campaign,
      response: personalApprovalResponseSchema.parse({
        recordId,
        recordVersion: record.updatedAt,
        packet,
        packetHash,
        blockers,
        approval,
        nonce: approvalNonce(
          env.JWT_SECRET,
          session,
          userId,
          recordId,
          record.updatedAt.toISOString(),
          packetHash,
        ),
      }),
    };
  }

  async get(userId: string, recordId: string, session: string) {
    return this.lock(
      userId,
      async (tx) => (await this.review(tx, userId, recordId, session)).response,
    );
  }

  async approve(userId: string, recordId: string, session: string, input: PersonalApprovalInput) {
    return this.lock(userId, async (tx) => {
      const { record, campaign, response } = await this.review(tx, userId, recordId, session);
      verifyApprovalNonce(
        env.JWT_SECRET,
        session,
        userId,
        recordId,
        input.expectedRecordVersion,
        input.packetHash,
        input.nonce,
      );
      if (
        !input.confirm ||
        record.updatedAt.toISOString() !== input.expectedRecordVersion ||
        response.packetHash !== input.packetHash
      )
        throw conflict("The application changed; review the current packet before approving");
      if (response.blockers.length || !campaign || !response.packet)
        throw conflict(response.blockers.join("; ") || "Application is not reviewable");
      const unresolved = await tx.personalAttempt.count({
        where: {
          userId,
          recordId,
          OR: [
            {
              submitAt: { not: null },
              state: { in: ["submitting", "submitted", "submission_uncertain"] },
            },
            {
              submitAt: null,
              state: { in: ["preparing", "prepared"] },
              leaseExpiresAt: { gt: new Date() },
            },
          ],
        },
      });
      if (unresolved)
        throw conflict("An active or unresolved attempt already owns this application");
      const receipt: PersonalApprovalReceipt = {
        id: crypto.randomUUID(),
        recordId,
        campaignId: campaign.campaignId,
        campaignRunId: response.packet.campaignRunId,
        packetHash: response.packetHash,
        packetArtifact: await saveApprovalPacket(userId, response.packet),
        approvedAt: new Date().toISOString(),
        expiresAt: approvalExpiry(readAttemptPolicy(campaign.config).timezone).toISOString(),
        approvedRecordVersion: input.expectedRecordVersion,
      };
      const details = objectValue(record.details);
      const result = await tx.personalRecord.updateMany({
        where: { id: recordId, userId, updatedAt: record.updatedAt },
        data: {
          details: jsonValue({
            ...details,
            applicationApprovals: [...approvalHistory(details), { kind: "approved", receipt }],
          }),
        },
      });
      if (result.count !== 1) throw conflict("Application changed while approving");
      return (await this.review(tx, userId, recordId, session)).response;
    });
  }

  async withdraw(
    userId: string,
    id: string,
    recordId: string,
    session: string,
    input: PersonalApprovalInput,
  ) {
    return this.lock(userId, async (tx) => {
      const { record, response } = await this.review(tx, userId, recordId, session);
      verifyApprovalNonce(
        env.JWT_SECRET,
        session,
        userId,
        recordId,
        input.expectedRecordVersion,
        input.packetHash,
        input.nonce,
      );
      if (
        !input.confirm ||
        record.updatedAt.toISOString() !== input.expectedRecordVersion ||
        response.packetHash !== input.packetHash
      )
        throw conflict("Application changed; refresh before withdrawing approval");
      const details = objectValue(record.details);
      const history = approvalHistory(details);
      if (!history.some((event) => event.kind === "approved" && event.receipt.id === id))
        throw notFound("Application approval not found");
      if (!history.some((event) => event.kind === "withdrawn" && event.approvalId === id)) {
        await tx.personalRecord.update({
          where: { id: recordId },
          data: {
            details: jsonValue({
              ...details,
              applicationApprovals: [
                ...history,
                { kind: "withdrawn", approvalId: id, at: new Date().toISOString() },
              ],
            }),
          },
        });
      }
      const pending = await tx.personalAttempt.findMany({
        where: {
          userId,
          recordId,
          submitAt: null,
          state: { in: ["preparing", "prepared"] },
          manifest: { path: ["applicationApproval", "id"], equals: id },
        },
        select: { id: true },
      });
      const ids = pending.map((attempt) => attempt.id);
      await tx.personalAttempt.updateMany({
        where: { userId, id: { in: ids }, submitAt: null },
        data: { state: "cancelled", leaseGeneration: { increment: 1 } },
      });
      await tx.personalReservation.deleteMany({ where: { userId, attemptId: { in: ids } } });
      return (await this.review(tx, userId, recordId, session)).response;
    });
  }
}
