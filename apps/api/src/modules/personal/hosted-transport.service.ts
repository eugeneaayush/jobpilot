import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type PersonalHostedTransportFreezeInput,
  personalHostedTransportFreezeSchema,
  personalHostedTransportResponseSchema,
} from "@jobpilot/contracts/personal-hosted-transport";
import { singleton } from "tsyringe";
import { z } from "zod";
import { conflict, notFound } from "@/common/errors";
import { type Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  parseLeverIdentity,
  readLeverFrozenRequest,
} from "../../../../../plugin/scripts/personal-browser/lever-network";
import { PersonalAttemptService } from "./attempt.service";
import { manifestHash, privateArtifactRoot, readPrivateArtifact } from "./persistence-policy";
import { jsonValue, objectValue } from "./runtime";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("lever_submission_payload"),
    attemptId: z.uuid(),
    manifestHash: hash,
    targetUrl: z.url().max(2000),
    requestBody: z.string().min(1).max(19_000_000),
    capturedAt: z.iso.datetime(),
  })
  .strict();
const storedSchema = personalHostedTransportResponseSchema
  .omit({ attemptId: true, status: true })
  .extend({ schemaVersion: z.literal(1), capturedAt: z.iso.datetime() })
  .strict();

@singleton()
export class PersonalHostedTransportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly attempts: PersonalAttemptService,
  ) {}

  protected async readArtifact(userId: string, evidenceHash: string) {
    const root = privateArtifactRoot(userId);
    return readPrivateArtifact(join(root, "challenges", `${evidenceHash}.json`), root);
  }

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

  async freeze(userId: string, id: string, input: PersonalHostedTransportFreezeInput) {
    const parsedInput = personalHostedTransportFreezeSchema.safeParse(input);
    if (!parsedInput.success) throw conflict("Invalid hosted transport freeze request.");
    return this.lock(userId, async (tx) => {
      const attempt = await tx.personalAttempt.findFirst({ where: { id, userId } });
      if (!attempt) throw notFound("Personal attempt not found");
      if (
        attempt.mode !== "submit" ||
        !attempt.submitAt ||
        attempt.state !== "submitting" ||
        attempt.leaseOwner !== input.leaseOwner ||
        attempt.leaseGeneration !== input.leaseGeneration ||
        attempt.leaseExpiresAt <= new Date() ||
        manifestHash(attempt.manifest) !== attempt.manifestHash
      )
        throw conflict(
          "Hosted transport requires the current submitting worker lease and immutable manifest.",
        );
      await this.attempts.verifyContinuationManifest(tx, userId, attempt);
      const record = await tx.personalRecord.findFirst({ where: { id: attempt.recordId, userId } });
      if (record?.state !== "applying")
        throw conflict("Hosted transport requires the original applying record.");
      const frozenManifest = objectValue(attempt.manifest);
      const posting = objectValue(objectValue(record.details).posting);
      let identity: ReturnType<typeof parseLeverIdentity>;
      try {
        identity = parseLeverIdentity(record.url, record.identity);
        if (
          typeof frozenManifest.canonicalUrl !== "string" ||
          parseLeverIdentity(frozenManifest.canonicalUrl, record.identity).postingUrl !==
            identity.postingUrl
        )
          throw new Error("changed manifest URL");
      } catch {
        throw conflict("Hosted transport source is not a verified Lever posting.");
      }
      if (
        frozenManifest.identity !== record.identity ||
        posting.source !== "lever" ||
        posting.boardToken !== identity.board ||
        posting.nativeId !== identity.postingId ||
        posting.sourceRegion !== identity.region
      )
        throw conflict("Hosted transport posting identity or region changed.");
      const bytes = await this.readArtifact(userId, input.evidenceHash);
      if (
        bytes.length > 20_000_000 ||
        createHash("sha256").update(bytes).digest("hex") !== input.evidenceHash
      )
        throw conflict("Hosted transport artifact SHA256 or size does not match.");
      let payload: z.infer<typeof payloadSchema>;
      try {
        payload = payloadSchema.parse(JSON.parse(bytes.toString("utf8")));
      } catch {
        throw conflict("Invalid hosted transport payload artifact.");
      }
      if (
        payload.attemptId !== id ||
        payload.manifestHash !== attempt.manifestHash ||
        payload.targetUrl !== identity.applyUrl ||
        Date.parse(payload.capturedAt) < attempt.submitAt.getTime() ||
        Date.parse(payload.capturedAt) > Date.now() + 60_000
      )
        throw conflict("Hosted transport artifact does not match the current submission boundary.");
      let hashes: Awaited<ReturnType<typeof readLeverFrozenRequest>>;
      try {
        hashes = await readLeverFrozenRequest(payload.requestBody, identity, payload.targetUrl);
      } catch {
        throw conflict("Hosted transport request bytes, encoding or digests are invalid.");
      }
      const transport = storedSchema.parse({
        schemaVersion: 1,
        provider: "lever",
        manifestHash: attempt.manifestHash,
        targetUrl: payload.targetUrl,
        ...hashes,
        evidenceHash: input.evidenceHash,
        capturedAt: payload.capturedAt,
      });
      const receipt = objectValue(attempt.receipt);
      if (attempt.leaseExpiresAt <= new Date())
        throw conflict("Hosted transport lease expired during validation.");
      if (receipt.hostedTransport !== undefined) {
        const previous = storedSchema.safeParse(receipt.hostedTransport);
        if (!previous.success || manifestHash(previous.data) !== manifestHash(transport))
          throw conflict("The first hosted submission transport is immutable.");
      } else {
        const updated = await tx.personalAttempt.updateMany({
          where: {
            id,
            userId,
            updatedAt: attempt.updatedAt,
            state: "submitting",
            leaseOwner: input.leaseOwner,
            leaseGeneration: input.leaseGeneration,
            leaseExpiresAt: { gt: new Date() },
          },
          data: { receipt: jsonValue({ ...receipt, hostedTransport: transport }) },
        });
        if (updated.count !== 1)
          throw conflict("Hosted transport lease or attempt changed before freeze.");
      }
      const { schemaVersion: _version, ...response } = transport;
      return personalHostedTransportResponseSchema.parse({
        ...response,
        attemptId: id,
        status: "frozen",
        capturedAt: new Date(transport.capturedAt),
      });
    });
  }
}
