import "reflect-metadata";
import { createHash } from "node:crypto";
import type { CryptoService } from "@/common/crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PersonalAttemptService } from "../attempt.service";
import { manifestHash } from "../persistence-policy";
import { buildApplicationEmailMime } from "./mime";
import { ApplicationEmailTransportService } from "./transport.service";
import { describe, expect, it } from "bun:test";

const owner = "10000000-0000-4000-8000-000000000001";
const attemptId = "20000000-0000-4000-8000-000000000001";
const bytes = Buffer.from("%PDF-1.7\nSynthetic\n%%EOF");
const hash = createHash("sha256").update(bytes).digest("hex");
const payload = {
  schemaVersion: 1 as const,
  recordId: "30000000-0000-4000-8000-000000000001",
  identity: "test:123",
  postingContentHash: "a".repeat(64),
  previewManifestHash: "b".repeat(64),
  verifiedCareerSourceHash: "c".repeat(64),
  to: "apply@example.com",
  subject: "Associate",
  body: "Please find my resume attached.",
  sourceQuote: "Email your application to apply@example.com.",
  sourceUrl: "https://example.com/careers/123",
  attachments: [
    {
      kind: "resume" as const,
      filename: "resume.pdf",
      mimeType: "application/pdf" as const,
      sha256: hash,
      bytes: bytes.length,
    },
  ],
};
const prepared = buildApplicationEmailMime(
  attemptId,
  "candidate@example.net",
  { ...payload, payloadHash: manifestHash(payload) },
  [bytes],
);
function harness(dispatched = false) {
  const mailbox = {
    userId: owner,
    provider: "gmail",
    email: "candidate@example.net",
    accessToken: "synthetic-token",
    scope:
      "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
    tokenExpiresAt: new Date(Date.now() + 600000),
    refreshFailedAt: null,
  };
  const row = {
    id: attemptId,
    userId: owner,
    recordId: payload.recordId,
    mode: "submit",
    state: "submitting",
    submitAt: new Date(),
    updatedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 90000),
    manifest: {
      postingContentHash: payload.postingContentHash,
      document: { sha256: hash },
      applicationEmailHash: prepared.payload.payloadHash,
    },
    manifestHash: manifestHash({
      postingContentHash: payload.postingContentHash,
      document: { sha256: hash },
      applicationEmailHash: prepared.payload.payloadHash,
    }),
    receipt: {
      emailTransport: {
        schemaVersion: 1,
        state: "claimed",
        claimId: "40000000-0000-4000-8000-000000000001",
        payloadHash: prepared.payload.payloadHash,
        mimeHash: prepared.mimeHash,
        messageId: prepared.messageId,
        from: prepared.proof.from,
        dispatchStartedAt: dispatched ? new Date().toISOString() : null,
        payload: prepared.payload,
        proof: prepared.proof,
      },
    },
  };
  const requests: { url: string; init: RequestInit }[] = [];
  let response: (url: string, init: RequestInit) => Promise<Response> = async () =>
    Response.json({ id: "gmail-message", threadId: "gmail-thread" });
  let available = true;
  let updated = 0;
  let validating: (attempt: { leaseExpiresAt: Date }) => Promise<void> = async () => {};
  const events: string[] = [];
  let inTransaction = false;
  const attempts = {
    verifyContinuationManifest: async (
      tx: unknown,
      userId: string,
      attempt: { id: string; leaseExpiresAt: Date },
    ) => {
      expect(inTransaction).toBe(true);
      expect(tx).toBe(prisma);
      expect(userId).toBe(owner);
      expect(attempt.id).toBe(attemptId);
      events.push("validated");
      await validating(attempt);
    },
  } as unknown as PersonalAttemptService;
  const prisma = {
    personalAttempt: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === row.id && where.userId === row.userId ? structuredClone(row) : null,
      updateMany: async ({ data }: { data: { receipt: typeof row.receipt } }) => {
        events.push("persisted");
        row.receipt = data.receipt;
        updated++;
        return { count: 1 };
      },
    },
    $queryRaw: async () => [{ id: owner }],
    $transaction: async (fn: (tx: unknown) => unknown) => {
      inTransaction = true;
      try {
        return await fn(prisma);
      } finally {
        inTransaction = false;
      }
    },
  };
  class SyntheticTransport extends ApplicationEmailTransportService {
    protected override async loadAccount() {
      return available ? mailbox : null;
    }
    protected override async request(url: string, init: RequestInit) {
      events.push("requested");
      requests.push({ url, init });
      if (init.method === "POST")
        expect(row.receipt.emailTransport.dispatchStartedAt).not.toBeNull();
      return response(url, init);
    }
  }
  return {
    service: new SyntheticTransport(
      prisma as unknown as PrismaClient,
      {} as CryptoService,
      attempts,
    ),
    mailbox,
    row,
    requests,
    updates: () => updated,
    events,
    validate: (fn: typeof validating) => {
      validating = fn;
    },
    disconnect: () => {
      available = false;
    },
    respond: (fn: typeof response) => {
      response = fn;
    },
  };
}

describe("persisted application email dispatch", () => {
  it("revalidates authoritative submission policy inside the final dispatch transaction", async () => {
    const h = harness();
    expect((await h.service.sendPrepared(owner, attemptId, prepared)).status).toBe(
      "provider_accepted",
    );
    expect(h.events).toEqual(["validated", "persisted", "requested"]);
  });
  it("a changed cap, settings, or eligibility before dispatch cannot send frozen MIME", async () => {
    for (const reason of [
      "User policy changed",
      "Employer active-application limit reached",
      "Submission source, identity or settings changed",
      "Recruiting constraint violated",
    ]) {
      const h = harness();
      h.validate(async () => {
        throw new Error(reason);
      });
      await expect(h.service.sendPrepared(owner, attemptId, prepared)).rejects.toThrow(reason);
      expect(h.updates()).toBe(0);
      expect(h.requests).toHaveLength(0);
      expect(h.row.receipt.emailTransport.dispatchStartedAt).toBeNull();
    }
  });
  it("an expired lease during final validation cannot be consumed", async () => {
    const h = harness();
    h.validate(async (attempt) => {
      attempt.leaseExpiresAt = new Date(0);
    });
    await expect(h.service.sendPrepared(owner, attemptId, prepared)).rejects.toThrow(
      "lease expired",
    );
    expect(h.requests).toHaveLength(0);
    expect(h.updates()).toBe(0);
  });
  it("preflights missing OAuth and scope without beginning a send", async () => {
    const h = harness();
    h.disconnect();
    expect((await h.service.preflight(owner)).status).toBe("blocked");
    expect((await h.service.sendPrepared(owner, attemptId, prepared)).status).toBe("blocked");
    expect(h.updates()).toBe(0);
    expect(h.requests).toHaveLength(0);
    const scoped = harness();
    scoped.mailbox.scope = "https://www.googleapis.com/auth/gmail.send";
    expect((await scoped.service.preflight(owner)).status).toBe("blocked");
  });
  it("persists one dispatch before one POST and never sends that claim twice", async () => {
    const h = harness();
    const result = await h.service.sendPrepared(owner, attemptId, prepared);
    expect(result.status).toBe("provider_accepted");
    expect(result.employerAcknowledged).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.init.redirect).toBe("error");
    expect(h.requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    await expect(h.service.sendPrepared(owner, attemptId, prepared)).rejects.toThrow();
    expect(h.requests).toHaveLength(1);
  });
  it("leaves timeout and provider rejection uncertain with no POST retry", async () => {
    for (const fail of [
      async () => {
        throw new Error("timeout");
      },
      async () => Response.json({ error: "unavailable" }, { status: 503 }),
    ]) {
      const h = harness();
      h.respond(fail);
      expect((await h.service.sendPrepared(owner, attemptId, prepared)).status).toBe("uncertain");
      expect(h.requests).toHaveLength(1);
      await expect(h.service.sendPrepared(owner, attemptId, prepared)).rejects.toThrow();
    }
  });
  it("rejects an unowned, unfrozen, changed or not-begun attempt before network", async () => {
    const foreign = harness();
    await expect(foreign.service.sendPrepared("foreign", attemptId, prepared)).rejects.toThrow();
    for (const change of [
      (h: ReturnType<typeof harness>) => {
        h.row.state = "prepared";
      },
      (h: ReturnType<typeof harness>) => {
        h.row.receipt.emailTransport.payloadHash = "f".repeat(64);
      },
      (h: ReturnType<typeof harness>) => {
        h.row.receipt.emailTransport.mimeHash = "f".repeat(64);
      },
    ]) {
      const h = harness();
      change(h);
      await expect(h.service.sendPrepared(owner, attemptId, prepared)).rejects.toThrow();
      expect(h.requests).toHaveLength(0);
    }
  });
});

describe("bounded sent-message reconciliation", () => {
  it("cannot reconcile an email that has no persisted dispatch claim", async () => {
    const h = harness();
    await expect(h.service.lookupSent(owner, attemptId)).rejects.toThrow();
    expect(h.requests).toHaveLength(0);
  });
  it("requires exact Sent message MIME evidence and returns provider-only confirmation", async () => {
    const h = harness(true);
    h.respond(async (url) =>
      url.includes("format=raw")
        ? Response.json({
            id: "sent",
            threadId: "thread",
            labelIds: ["SENT"],
            raw: Buffer.from(`Received: provider\r\n${prepared.raw}`).toString("base64url"),
          })
        : Response.json({ messages: [{ id: "sent" }] }),
    );
    const result = await h.service.lookupSent(owner, attemptId);
    expect(result.status).toBe("provider_sent_verified");
    expect(result.employerAcknowledged).toBe(false);
    expect(h.requests).toHaveLength(2);
    expect(h.requests.every((request) => request.init.method === "GET")).toBe(true);
    expect(h.requests[0]?.url).toContain("rfc822msgid");
  });
  it("never treats missing, nonmatching or multiple messages as proof of no submission", async () => {
    for (const response of [
      { messages: [] },
      { messages: [{ id: "one" }, { id: "two" }] },
      { messages: [{ id: "one" }], nextPageToken: "more" },
    ]) {
      const h = harness(true);
      h.respond(async () => Response.json(response));
      const result = await h.service.lookupSent(owner, attemptId);
      expect(result.status).toBe("uncertain");
      expect(result.canResend).toBe(false);
      expect(h.requests.every((request) => request.init.method === "GET")).toBe(true);
    }
    const h = harness(true);
    h.respond(async (url) =>
      url.includes("format=raw")
        ? Response.json({
            id: "sent",
            labelIds: ["SENT"],
            raw: Buffer.from(
              prepared.raw.replace("To: apply@example.com", "To: wrong@example.com"),
            ).toString("base64url"),
          })
        : Response.json({ messages: [{ id: "sent" }] }),
    );
    expect((await h.service.lookupSent(owner, attemptId)).status).toBe("uncertain");
  });
});
