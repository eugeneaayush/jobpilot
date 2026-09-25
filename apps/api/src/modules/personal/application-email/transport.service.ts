import { createHash } from "node:crypto";
import { applicationEmailTransportFreezeSchema } from "@jobpilot/contracts/personal-application-email";
import { singleton } from "tsyringe";
import { z } from "zod/v4";
import { CryptoService } from "@/common/crypto";
import { conflict } from "@/common/errors";
import { type Prisma, PrismaClient } from "@/generated/prisma/client";
import { loadFreshAccount } from "../../email/account/account.utils";
import { PersonalAttemptService } from "../attempt.service";
import { manifestHash } from "../persistence-policy";
import { matchesApplicationEmailMime, type PreparedApplicationEmail } from "./mime";

interface Mailbox {
  userId: string;
  provider: string;
  email: string;
  accessToken: string | null;
  scope: string | null;
  tokenExpiresAt: Date | null;
  refreshFailedAt: Date | null;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const freeze = (receipt: unknown) =>
  applicationEmailTransportFreezeSchema.parse(object(receipt).emailTransport);
const noEmployerReceipt = { employerAcknowledged: false as const, canResend: false as const };
const messageSchema = z.object({
  id: z.string().min(1).max(300),
  threadId: z.string().max(300).optional(),
});
const gmail = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

async function boundedJson(response: Response, maximum = 32768): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Provider response unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maximum) throw new Error("Provider response exceeds receipt bounds");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

@singleton()
export class ApplicationEmailTransportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly crypto: CryptoService,
    private readonly attempts: PersonalAttemptService,
  ) {}

  protected async loadAccount(userId: string): Promise<Mailbox | null> {
    return (await loadFreshAccount(this.prisma, this.crypto, userId))?.account ?? null;
  }

  protected request(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  private async connected(userId: string) {
    let account: Mailbox | null;
    try {
      account = await this.loadAccount(userId);
    } catch {
      return {
        status: "blocked" as const,
        reason:
          "Reconnect the owned Gmail account and OAuth client before beginning an application.",
      };
    }
    if (account && account.userId !== userId)
      throw conflict("Email account ownership does not match.");
    if (
      account?.provider !== "gmail" ||
      !account.accessToken ||
      account.refreshFailedAt ||
      (account.tokenExpiresAt && account.tokenExpiresAt <= new Date())
    )
      return {
        status: "blocked" as const,
        reason: "A connected, current Gmail account is required before beginning an application.",
      };
    const scopes = new Set(account.scope?.split(/\s+/));
    if (
      !scopes.has("https://www.googleapis.com/auth/gmail.send") ||
      !scopes.has("https://www.googleapis.com/auth/gmail.readonly")
    )
      return {
        status: "blocked" as const,
        reason:
          "Gmail send and read scopes are required for application dispatch and receipt reconciliation.",
      };
    return { status: "ready" as const, account };
  }

  async preflight(userId: string) {
    const connection = await this.connected(userId);
    if (connection.status === "blocked") return connection;
    return { status: "ready" as const, provider: "gmail" as const, from: connection.account.email };
  }

  async sendPrepared(userId: string, attemptId: string, prepared: PreparedApplicationEmail) {
    const connection = await this.connected(userId);
    if (connection.status === "blocked") return { ...connection, ...noEmployerReceipt };
    if (
      prepared.proof.from !== connection.account.email ||
      digest(prepared.raw) !== prepared.mimeHash ||
      !matchesApplicationEmailMime(prepared.raw, prepared.proof)
    )
      throw conflict("Prepared email bytes or sending account changed.");
    const dispatchedAt = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        const owners = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!owners.length) throw conflict("Application owner is unavailable.");
        const attempt = await tx.personalAttempt.findFirst({ where: { id: attemptId, userId } });
        if (
          attempt?.mode !== "submit" ||
          attempt.state !== "submitting" ||
          !attempt.submitAt ||
          attempt.leaseExpiresAt <= dispatchedAt
        )
          throw conflict(
            "A begun submission with a current lease is required before email dispatch.",
          );
        const stored = freeze(attempt.receipt);
        const manifest = object(attempt.manifest);
        if (
          stored.dispatchStartedAt !== null ||
          manifestHash(attempt.manifest) !== attempt.manifestHash ||
          manifest.applicationEmailHash !== stored.payloadHash ||
          stored.payloadHash !== prepared.payload.payloadHash ||
          stored.mimeHash !== prepared.mimeHash ||
          stored.messageId !== prepared.messageId ||
          stored.from !== connection.account.email ||
          prepared.messageId !== `<jobpilot-${attemptId}@local.jobpilot>` ||
          manifestHash(stored.payload) !== manifestHash(prepared.payload) ||
          manifestHash(stored.proof) !== manifestHash(prepared.proof) ||
          stored.payload.recordId !== attempt.recordId ||
          manifest.postingContentHash !== stored.payload.postingContentHash ||
          object(manifest.document).sha256 !==
            stored.payload.attachments.find((item) => item.kind === "resume")?.sha256
        )
          throw conflict("Email dispatch requires its exact unused, persisted transport claim.");
        await this.attempts.verifyContinuationManifest(tx, userId, attempt);
        if (attempt.leaseExpiresAt <= new Date())
          throw conflict("Email dispatch lease expired during policy validation.");
        const receipt = {
          ...object(attempt.receipt),
          emailTransport: { ...stored, dispatchStartedAt: dispatchedAt.toISOString() },
        };
        const result = await tx.personalAttempt.updateMany({
          where: {
            id: attemptId,
            userId,
            updatedAt: attempt.updatedAt,
            state: "submitting",
            leaseExpiresAt: { gt: new Date() },
          },
          data: { receipt: receipt as Prisma.InputJsonValue },
        });
        if (result.count !== 1)
          throw conflict("Email dispatch claim changed; reconcile before continuing.");
      },
      { timeout: 15000 },
    );
    try {
      // Native fetch performs one POST; provider retries and redirects must not create another submission.
      const response = await this.request(`${gmail}/send`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${connection.account.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw: Buffer.from(prepared.raw).toString("base64url") }),
      });
      const sent = messageSchema.parse(await boundedJson(response));
      return {
        status: "provider_accepted" as const,
        ...noEmployerReceipt,
        provider: "gmail" as const,
        providerMessageId: sent.id,
        threadId: sent.threadId ?? null,
        messageId: prepared.messageId,
        payloadHash: prepared.payload.payloadHash,
        mimeHash: prepared.mimeHash,
        proof: prepared.proof,
        dispatchedAt: dispatchedAt.toISOString(),
      };
    } catch {
      return {
        status: "uncertain" as const,
        ...noEmployerReceipt,
        reason:
          "Dispatch began without a conclusive provider receipt. Reconcile Sent mail; do not resend.",
        messageId: prepared.messageId,
        payloadHash: prepared.payload.payloadHash,
        mimeHash: prepared.mimeHash,
        dispatchedAt: dispatchedAt.toISOString(),
      };
    }
  }

  async lookupSent(userId: string, attemptId: string) {
    const attempt = await this.prisma.personalAttempt.findFirst({
      where: { id: attemptId, userId },
    });
    if (attempt?.mode !== "submit" || !attempt.submitAt)
      throw conflict("A persisted submission attempt is required for reconciliation.");
    const stored = freeze(attempt.receipt);
    if (!stored.dispatchStartedAt || stored.messageId !== `<jobpilot-${attemptId}@local.jobpilot>`)
      throw conflict("The original persisted email dispatch is required for reconciliation.");
    const connection = await this.connected(userId);
    if (connection.status === "blocked") return { ...connection, ...noEmployerReceipt };
    if (connection.account.email !== stored.from)
      throw conflict("The original sending mailbox is required for reconciliation.");
    const inconclusive = {
      status: "uncertain" as const,
      ...noEmployerReceipt,
      reason:
        "No unique exact Sent receipt was verified. Missing mail is not proof of no submission.",
    };
    const options = () => ({
      method: "GET",
      redirect: "error" as const,
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${connection.account.accessToken}` },
    });
    try {
      const query = new URLSearchParams({
        q: `in:sent rfc822msgid:${stored.messageId}`,
        maxResults: "2",
      });
      const listed = z
        .object({
          messages: z
            .array(z.object({ id: z.string().min(1).max(300) }))
            .max(2)
            .optional(),
          nextPageToken: z.string().optional(),
        })
        .parse(await boundedJson(await this.request(`${gmail}?${query}`, options())));
      if (listed.nextPageToken || listed.messages?.length !== 1) return inconclusive;
      const id = listed.messages[0]!.id;
      const message = messageSchema
        .extend({ labelIds: z.array(z.string()).max(100), raw: z.string().max(30_000_000) })
        .parse(
          await boundedJson(
            await this.request(`${gmail}/${encodeURIComponent(id)}?format=raw`, options()),
            32_000_000,
          ),
        );
      if (
        message.id !== id ||
        !message.labelIds.includes("SENT") ||
        !/^[A-Za-z0-9_-]+={0,2}$/.test(message.raw) ||
        !matchesApplicationEmailMime(
          Buffer.from(message.raw, "base64url").toString("utf8"),
          stored.proof,
        )
      )
        return inconclusive;
      return {
        status: "provider_sent_verified" as const,
        ...noEmployerReceipt,
        provider: "gmail" as const,
        providerMessageId: message.id,
        threadId: message.threadId ?? null,
        messageId: stored.messageId,
        payloadHash: stored.payloadHash,
        mimeHash: stored.mimeHash,
        proof: stored.proof,
      };
    } catch {
      return inconclusive;
    }
  }
}
