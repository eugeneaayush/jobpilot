import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type PersonalHandoff,
  type PersonalHandoffLease,
  personalHandoffResponseSchema,
} from "@jobpilot/contracts/personal-handoff";
import { singleton } from "tsyringe";
import { conflict, notFound } from "@/common/errors";
import { type Prisma, PrismaClient } from "@/generated/prisma/client";
import { manifestHash, privateArtifactRoot, readPrivateArtifact } from "./persistence-policy";
import { jsonValue, objectValue, sha256 } from "./runtime";

const leaseMs = 90_000;
const deadlineMs = 15 * 60_000;
const active = ["opening", "open", "resuming"];

@singleton()
export class PersonalHandoffService {
  constructor(private readonly prisma: PrismaClient) {}

  private locked<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
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

  private async owned(tx: Prisma.TransactionClient, userId: string, attemptId: string) {
    const attempt = await tx.personalAttempt.findFirst({
      where: { id: attemptId, userId },
      include: { record: true },
    });
    if (!attempt) throw notFound("Attempt not found");
    if (["submitted", "submission_uncertain"].includes(attempt.record.state))
      throw conflict("Reconcile the existing application before opening a security handoff");
    const competing = await tx.personalAttempt.count({
      where: {
        userId,
        recordId: attempt.recordId,
        id: { not: attemptId },
        state: { in: ["preparing", "prepared", "submitting", "submitted", "submission_uncertain"] },
      },
    });
    if (competing) throw conflict("Another active or possibly submitted attempt owns this job");
    if (
      attempt.mode === "offline" ||
      attempt.submitAt ||
      ["submitted", "submission_uncertain", "submitting"].includes(attempt.state)
    )
      throw conflict(
        "Security handoff is only available before any possible submission in a live mode.",
      );
    if (manifestHash(attempt.manifest) !== attempt.manifestHash)
      throw conflict("Manifest integrity check failed");
    return attempt;
  }

  private async save(
    tx: Prisma.TransactionClient,
    record: { id: string; userId: string; updatedAt: Date },
    details: unknown,
    blocked = false,
  ) {
    const changed = await tx.personalRecord.updateMany({
      where: { id: record.id, userId: record.userId, updatedAt: record.updatedAt },
      data: { details: jsonValue(details), ...(blocked ? { state: "blocked" } : {}) },
    });
    if (changed.count !== 1)
      throw conflict("Record changed during browser handoff; reload its source context");
  }

  async request(
    userId: string,
    attemptId: string,
    input: { leaseOwner: string; leaseGeneration: number; reason: PersonalHandoff["reason"] },
  ) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, attemptId);
      if (
        !["preparing", "prepared"].includes(attempt.state) ||
        attempt.leaseOwner !== input.leaseOwner ||
        attempt.leaseGeneration !== input.leaseGeneration ||
        attempt.leaseExpiresAt <= new Date()
      )
        throw conflict("A current preparation lease is required to park a security handoff.");
      const details = objectValue(attempt.record.details);
      const now = new Date();
      const handoff: PersonalHandoff = {
        handoffId: randomUUID(),
        attemptId,
        recordId: attempt.recordId,
        profileKey: userId,
        allowedOrigin: new URL(attempt.record.url).origin,
        reason: input.reason,
        status: "parked",
        leaseOwner: `handoff:${randomUUID()}`,
        leaseGeneration: 1,
        leaseExpiresAt: now.toISOString(),
        updatedAt: now.toISOString(),
        browserOpen: false,
        events: [
          {
            sequence: 0,
            at: now.toISOString(),
            type: "parked",
            message: "User browser action required; application submission is disabled in handoff.",
          },
        ],
      };
      await tx.personalAttempt.update({
        where: { id: attemptId },
        data: {
          state: "blocked",
          leaseGeneration: { increment: 1 },
          receipt: {
            outcome: "blocked",
            reason: `Browser ${input.reason} handoff required`,
            parkedAt: now.toISOString(),
            manifestHash: attempt.manifestHash,
            handoffId: handoff.handoffId,
          },
        },
      });
      await tx.personalReservation.deleteMany({ where: { userId, attemptId } });
      const prior = Array.isArray(details.handoffHistory) ? details.handoffHistory : [];
      await this.save(
        tx,
        attempt.record,
        { ...details, handoff, handoffHistory: [...prior, handoff] },
        true,
      );
      return handoff;
    });
  }

  async get(userId: string, attemptId: string) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, attemptId);
      const details = objectValue(attempt.record.details);
      const parsed = personalHandoffResponseSchema.safeParse(details.handoff);
      if (!parsed.success || parsed.data.attemptId !== attemptId)
        throw notFound("No security handoff is registered for this attempt");
      const handoff = parsed.data;
      if (active.includes(handoff.status) && Date.parse(handoff.leaseExpiresAt) <= Date.now()) {
        handoff.status = "expired";
        handoff.browserOpen = false;
        handoff.updatedAt = new Date().toISOString();
        await this.save(tx, attempt.record, { ...details, handoff });
      }
      return handoff;
    });
  }

  async transition(
    userId: string,
    attemptId: string,
    action: "open" | "heartbeat" | "resume" | "cancel",
    input: PersonalHandoffLease,
  ) {
    return this.locked(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, attemptId);
      if (attempt.state !== "blocked")
        throw conflict("Only a blocked preparation can use a browser handoff");
      const details = objectValue(attempt.record.details);
      const handoff = personalHandoffResponseSchema.parse(details.handoff);
      if (
        handoff.attemptId !== attemptId ||
        handoff.handoffId !== input.handoffId ||
        handoff.leaseOwner !== input.leaseOwner ||
        handoff.leaseGeneration !== input.leaseGeneration
      )
        throw conflict("Browser handoff ownership changed");
      const now = new Date();
      const startedAt =
        typeof details.handoffStartedAt === "string"
          ? Date.parse(details.handoffStartedAt)
          : now.getTime();
      if (action === "open") {
        if (!["parked", "expired", "cancelled"].includes(handoff.status))
          throw conflict("The browser handoff is already owned or resolved");
        const records = await tx.personalRecord.findMany({
          where: { userId },
          select: { id: true, details: true },
        });
        if (
          records.some((record) => {
            const other = objectValue(objectValue(record.details).handoff);
            return (
              record.id !== attempt.recordId &&
              active.includes(String(other.status)) &&
              Date.parse(String(other.leaseExpiresAt)) > Date.now()
            );
          })
        )
          throw conflict("Another browser handoff owns this user's profile");
        handoff.leaseGeneration += 1;
        handoff.status = "open";
        handoff.browserOpen = false;
        details.handoffStartedAt = now.toISOString();
      } else if (action === "cancel") {
        handoff.status = "cancelled";
        handoff.browserOpen = false;
      } else {
        if (
          !active.includes(handoff.status) ||
          Date.parse(handoff.leaseExpiresAt) <= now.getTime() ||
          now.getTime() - startedAt >= deadlineMs
        )
          throw conflict("Browser handoff expired; close the old window before reopening");
        if (action === "resume") {
          if (!input.proofHash) throw conflict("An inspected browser-session receipt is required");
          const bytes = await readPrivateArtifact(
            join(privateArtifactRoot(userId), "handoffs", `${input.proofHash}.json`),
            privateArtifactRoot(userId),
          );
          if (sha256(bytes) !== input.proofHash)
            throw conflict("Browser-session receipt hash mismatch");
          const proof = objectValue(JSON.parse(bytes.toString()));
          const postingHash =
            objectValue(details.posting).contentHash ?? manifestHash(details.posting ?? {});
          if (
            proof.handoffId !== handoff.handoffId ||
            proof.attemptId !== attemptId ||
            proof.recordId !== attempt.recordId ||
            proof.manifestHash !== attempt.manifestHash ||
            proof.postingContentHash !== postingHash ||
            proof.leaseGeneration !== handoff.leaseGeneration ||
            proof.sourceUrl !== attempt.record.url ||
            proof.noSubmission !== true ||
            proof.securityClear !== true ||
            proof.applicationFormObserved !== true ||
            proof.profileClosed !== true ||
            typeof proof.capturedAt !== "string" ||
            !Number.isFinite(Date.parse(proof.capturedAt)) ||
            Date.parse(proof.capturedAt) < startedAt ||
            Date.parse(proof.capturedAt) > now.getTime()
          )
            throw conflict(
              "Browser-session evidence does not prove this parked job is ready to re-inspect",
            );
          details.browserSessionEvidence = {
            sessionId: handoff.handoffId,
            sha256: input.proofHash,
            postingContentHash: postingHash,
            verified: true,
            verifiedAt: now.toISOString(),
          };
          handoff.status = "resolved";
          handoff.browserOpen = false;
        }
      }
      handoff.updatedAt = now.toISOString();
      handoff.leaseExpiresAt = new Date(
        Math.min(
          now.getTime() + leaseMs,
          (action === "open" ? now.getTime() : startedAt) + deadlineMs,
        ),
      ).toISOString();
      if (action !== "heartbeat")
        handoff.events = [
          ...(handoff.events ?? []),
          {
            sequence: handoff.events?.length ?? 0,
            at: now.toISOString(),
            type: action,
            message:
              action === "resume"
                ? "Browser session verified. Resolve the blocked job separately; no application was submitted."
                : `Browser handoff ${action}.`,
          },
        ].slice(-30);
      await this.save(tx, attempt.record, { ...details, handoff });
      return handoff;
    });
  }
}
