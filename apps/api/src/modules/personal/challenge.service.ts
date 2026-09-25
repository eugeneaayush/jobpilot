import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PersonalAttemptLeaseInput } from "@jobpilot/contracts/personal-attempt";
import {
  type PersonalChallengeFence,
  personalChallengeResponseSchema,
} from "@jobpilot/contracts/personal-challenge";
import { singleton } from "tsyringe";
import { conflict, notFound } from "@/common/errors";
import { type PersonalAttempt, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { PersonalAttemptService } from "./attempt.service";
import {
  type ChallengeLedger,
  challengeLedgerSchema,
  challengePayloadArtifactSchema,
  challengeRequest,
  challengeResponse,
  challengeResponseArtifactSchema,
} from "./challenge-policy";
import { manifestHash, privateArtifactRoot, readPrivateArtifact } from "./persistence-policy";
import { jsonValue, objectValue } from "./runtime";

const LEASE_MS = 90_000;
const CHALLENGE_MS = 15 * 60_000;

@singleton()
export class PersonalChallengeService {
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
      { timeout: 15000 },
    );
  }

  private async owned(tx: Prisma.TransactionClient, userId: string, id: string) {
    const attempt = await tx.personalAttempt.findFirst({ where: { id, userId } });
    if (!attempt) throw notFound("Personal attempt not found");
    return attempt;
  }

  private held(attempt: PersonalAttempt) {
    if (
      attempt.mode !== "submit" ||
      !attempt.submitAt ||
      !["submitting", "submission_uncertain"].includes(attempt.state) ||
      manifestHash(attempt.manifest) !== attempt.manifestHash
    )
      throw conflict("Challenge requires the original unresolved submit attempt.");
  }

  private ledger(attempt: PersonalAttempt): ChallengeLedger {
    const parsed = challengeLedgerSchema.safeParse(objectValue(attempt.receipt).challengeLedger);
    if (!parsed.success) throw conflict("Submission transport has not been frozen.");
    return parsed.data;
  }

  private async artifact(userId: string, evidenceHash: string) {
    if (!/^[a-f0-9]{64}$/.test(evidenceHash)) throw conflict("Invalid challenge artifact hash.");
    const bytes = await readPrivateArtifact(
      join(privateArtifactRoot(userId), "challenges", `${evidenceHash}.json`),
      privateArtifactRoot(userId),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== evidenceHash)
      throw conflict("Challenge artifact SHA256 does not match.");
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw conflict("Challenge artifact must contain valid JSON.");
    }
  }

  private bound(
    attempt: PersonalAttempt,
    artifact: { attemptId: string; manifestHash: string; capturedAt: string },
  ) {
    if (
      artifact.attemptId !== attempt.id ||
      artifact.manifestHash !== attempt.manifestHash ||
      !attempt.submitAt ||
      new Date(artifact.capturedAt) < attempt.submitAt ||
      new Date(artifact.capturedAt).getTime() > Date.now() + 60_000
    )
      throw conflict("Challenge artifact does not match this submission boundary.");
  }

  private event(ledger: ChallengeLedger, kind: string, data: unknown) {
    ledger.events.push({
      at: new Date().toISOString(),
      kind,
      data: JSON.parse(JSON.stringify(data)),
    });
  }

  private async save(
    tx: Prisma.TransactionClient,
    attempt: PersonalAttempt,
    ledger: ChallengeLedger,
    revoke = false,
  ) {
    await tx.personalAttempt.update({
      where: { id: attempt.id },
      data: {
        receipt: jsonValue({ ...objectValue(attempt.receipt), challengeLedger: ledger }),
        ...(revoke
          ? {
              state: "submission_uncertain",
              leaseGeneration: { increment: 1 },
              leaseExpiresAt: new Date(),
            }
          : {}),
      },
    });
    if (revoke)
      await tx.personalRecord.update({
        where: { id: attempt.recordId },
        data: { state: "submission_uncertain" },
      });
  }

  private response(attempt: PersonalAttempt, ledger: ChallengeLedger | null) {
    const current = ledger?.current;
    return personalChallengeResponseSchema.parse({
      attemptId: attempt.id,
      transport: ledger?.transport ?? null,
      challenge: current
        ? {
            ...current,
            status: attempt.state === "submitted" ? "resolved" : current.status,
            leaseExpiresAt: current.leaseExpiresAt ? new Date(current.leaseExpiresAt) : null,
            createdAt: new Date(current.createdAt),
            expiresAt: new Date(current.expiresAt),
            permit: current.permit
              ? { ...current.permit, expiresAt: new Date(current.permit.expiresAt) }
              : null,
          }
        : null,
    });
  }

  private async expire(
    tx: Prisma.TransactionClient,
    attempt: PersonalAttempt,
    ledger: ChallengeLedger,
  ) {
    const current = ledger.current;
    if (
      current &&
      !["continuing", "cancelled", "expired", "resolved"].includes(current.status) &&
      (Date.parse(current.expiresAt) <= Date.now() ||
        (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= Date.now()))
    ) {
      current.status = "expired";
      current.leaseGeneration++;
      this.event(ledger, "expired", current);
      await this.save(tx, attempt, ledger);
    }
  }

  async get(userId: string, id: string) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      if (!objectValue(attempt.receipt).challengeLedger) return this.response(attempt, null);
      const ledger = this.ledger(attempt);
      await this.expire(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }

  async freeze(
    userId: string,
    id: string,
    input: PersonalAttemptLeaseInput & { evidenceHash: string },
  ) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      if (
        attempt.state !== "submitting" ||
        attempt.leaseOwner !== input.leaseOwner ||
        attempt.leaseGeneration !== input.leaseGeneration ||
        attempt.leaseExpiresAt <= new Date()
      )
        throw conflict("Submission transport requires the current submitting worker lease.");
      await this.attempts.verifyContinuationManifest(tx, userId, attempt);
      const parsed = challengePayloadArtifactSchema.safeParse(
        await this.artifact(userId, input.evidenceHash),
      );
      if (!parsed.success) throw conflict("Invalid submission payload artifact.");
      this.bound(attempt, parsed.data);
      const transport = {
        ...challengeRequest(
          parsed.data.requestBody,
          String(objectValue(attempt.manifest).identity),
          parsed.data.targetUrl,
        ),
        manifestHash: attempt.manifestHash,
        targetUrl: parsed.data.targetUrl,
        evidenceHash: input.evidenceHash,
        capturedAt: parsed.data.capturedAt,
      };
      if (objectValue(attempt.receipt).challengeLedger) {
        const existing = this.ledger(attempt);
        if (manifestHash(existing.transport) !== manifestHash(transport))
          throw conflict("The first submission transport is immutable.");
        return this.response(attempt, existing);
      }
      const ledger: ChallengeLedger = { version: 1, transport, current: null, events: [] };
      this.event(ledger, "frozen", transport);
      await this.save(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }

  async register(userId: string, id: string, input: { evidenceHash: string }) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      const ledger = this.ledger(attempt);
      if (
        ledger.events.some(
          (event) =>
            event.kind === "registered" &&
            objectValue(event.data).evidenceHash === input.evidenceHash,
        )
      )
        return this.response(attempt, ledger);
      const parsed = challengeResponseArtifactSchema.safeParse(
        await this.artifact(userId, input.evidenceHash),
      );
      if (!parsed.success) throw conflict("Invalid Greenhouse challenge response artifact.");
      const proof = parsed.data;
      this.bound(attempt, proof);
      const current = ledger.current;
      if (current && (current.status !== "continuing" || current.permit?.status !== "consumed"))
        throw conflict("A new challenge requires the preceding one-use continuation.");
      const expectedRequest = current?.permit?.requestBodyHash ?? ledger.transport.requestBodyHash;
      const earliest = current?.permit ? ledger.events.at(-1)?.at : ledger.transport.capturedAt;
      if (
        proof.targetUrl !== ledger.transport.targetUrl ||
        proof.applicationPayloadHash !== ledger.transport.applicationPayloadHash ||
        proof.requestBodyHash !== expectedRequest ||
        (earliest && Date.parse(proof.capturedAt) < Date.parse(earliest))
      )
        throw conflict("Challenge response does not match the pinned request.");
      const response = challengeResponse(proof.responseBody);
      const now = new Date();
      ledger.current = {
        challengeId: randomUUID(),
        ...response,
        hasRecipient:
          response.hasRecipient ||
          (response.code !== "captcha-retry" && current?.hasRecipient === true),
        status: "awaiting_user",
        leaseOwner: null,
        leaseGeneration: 0,
        leaseExpiresAt: null,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CHALLENGE_MS).toISOString(),
        evidenceHash: input.evidenceHash,
        permit: null,
      };
      this.event(ledger, "registered", ledger.current);
      await this.save(tx, attempt, ledger, true);
      return this.response(attempt, ledger);
    });
  }

  private fence(ledger: ChallengeLedger, input: PersonalChallengeFence) {
    const current = ledger.current;
    if (
      !current ||
      current.challengeId !== input.challengeId ||
      current.leaseOwner !== input.leaseOwner ||
      current.leaseGeneration !== input.leaseGeneration ||
      !current.leaseExpiresAt ||
      Date.parse(current.leaseExpiresAt) <= Date.now() ||
      Date.parse(current.expiresAt) <= Date.now()
    )
      throw conflict("Challenge lease is stale or expired; submission remains held.");
    return current;
  }

  async lease(
    userId: string,
    id: string,
    input: { challengeId: string; leaseOwner: string; explicitUser: true },
  ) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      const ledger = this.ledger(attempt);
      const current = ledger.current;
      if (
        input.explicitUser !== true ||
        !current ||
        current.challengeId !== input.challengeId ||
        current.status !== "awaiting_user" ||
        Date.parse(current.expiresAt) <= Date.now()
      )
        throw conflict("An awaiting challenge requires an explicit user action before leasing.");
      await this.attempts.verifyContinuationManifest(tx, userId, attempt);
      current.status = "leased";
      current.leaseOwner = input.leaseOwner;
      current.leaseGeneration++;
      current.leaseExpiresAt = new Date(
        Math.min(Date.now() + LEASE_MS, Date.parse(current.expiresAt)),
      ).toISOString();
      this.event(ledger, "leased", current);
      await this.save(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }

  async checkpoint(userId: string, id: string, input: PersonalChallengeFence) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      const ledger = this.ledger(attempt);
      const current = this.fence(ledger, input);
      if (current.status !== "leased")
        throw conflict("Only a user challenge lease may be renewed.");
      await this.attempts.verifyContinuationManifest(tx, userId, attempt);
      current.leaseExpiresAt = new Date(
        Math.min(Date.now() + LEASE_MS, Date.parse(current.expiresAt)),
      ).toISOString();
      this.event(ledger, "checkpoint", {
        challengeId: current.challengeId,
        leaseExpiresAt: current.leaseExpiresAt,
      });
      await this.save(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }

  async continue(
    userId: string,
    id: string,
    input: PersonalChallengeFence & { explicitUser: true; evidenceHash: string },
  ) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      const ledger = this.ledger(attempt);
      const current = this.fence(ledger, input);
      if (input.explicitUser !== true || current.status !== "leased" || current.permit)
        throw conflict("Each challenge permits one explicitly requested continuation only.");
      await this.attempts.verifyContinuationManifest(tx, userId, attempt);
      const parsed = challengePayloadArtifactSchema.safeParse(
        await this.artifact(userId, input.evidenceHash),
      );
      if (!parsed.success) throw conflict("Invalid continuation payload artifact.");
      this.bound(attempt, parsed.data);
      const payload = challengeRequest(
        parsed.data.requestBody,
        String(objectValue(attempt.manifest).identity),
        parsed.data.targetUrl,
      );
      if (
        payload.applicationPayloadHash !== ledger.transport.applicationPayloadHash ||
        payload.fingerprintHash !== ledger.transport.fingerprintHash ||
        parsed.data.targetUrl !== ledger.transport.targetUrl ||
        Date.parse(parsed.data.capturedAt) < Date.parse(current.createdAt)
      )
        throw conflict(
          "Continuation must retain the original application payload, fingerprint and destination.",
        );
      current.status = "permitted";
      current.permit = {
        permitId: randomUUID(),
        status: "issued",
        expiresAt: current.leaseExpiresAt!,
        requestBodyHash: payload.requestBodyHash,
        evidenceHash: input.evidenceHash,
      };
      this.event(ledger, "permitted", current);
      await this.save(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }

  async consume(userId: string, id: string, input: PersonalChallengeFence & { permitId: string }) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      const ledger = this.ledger(attempt);
      const current = this.fence(ledger, input);
      if (
        current.status !== "permitted" ||
        !current.permit ||
        current.permit.permitId !== input.permitId ||
        current.permit.status !== "issued" ||
        Date.parse(current.permit.expiresAt) <= Date.now()
      )
        throw conflict(
          "Continuation permit is unavailable or already consumed; never repeat the POST.",
        );
      await this.attempts.verifyContinuationManifest(tx, userId, attempt);
      const parsed = challengePayloadArtifactSchema.safeParse(
        await this.artifact(userId, current.permit.evidenceHash),
      );
      if (!parsed.success) throw conflict("Continuation artifact is unavailable.");
      const payload = challengeRequest(
        parsed.data.requestBody,
        String(objectValue(attempt.manifest).identity),
        parsed.data.targetUrl,
      );
      if (
        payload.requestBodyHash !== current.permit.requestBodyHash ||
        payload.applicationPayloadHash !== ledger.transport.applicationPayloadHash
      )
        throw conflict("Continuation payload changed after authorization.");
      current.status = "continuing";
      current.permit.status = "consumed";
      this.event(ledger, "consumed", current);
      await this.save(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }

  async cancel(userId: string, id: string, input: PersonalChallengeFence) {
    return this.lock(userId, async (tx) => {
      const attempt = await this.owned(tx, userId, id);
      this.held(attempt);
      const ledger = this.ledger(attempt);
      const current = this.fence(ledger, input);
      if (!["leased", "permitted"].includes(current.status))
        throw conflict("A dispatched continuation remains uncertain.");
      current.status = "cancelled";
      current.leaseGeneration++;
      this.event(ledger, "cancelled", current);
      await this.save(tx, attempt, ledger);
      return this.response(attempt, ledger);
    });
  }
}
