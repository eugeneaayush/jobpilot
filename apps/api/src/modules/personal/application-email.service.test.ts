import "reflect-metadata";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ApplicationEmailTransportService } from "./application-email/transport.service";
import { PersonalApplicationEmailService } from "./application-email.service";
import type { PersonalAttemptService } from "./attempt.service";
import { manifestHash } from "./persistence-policy";
import { describe, expect, it } from "bun:test";

const owner = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const attemptId = "30000000-0000-4000-8000-000000000001";
const bytes = Buffer.from("%PDF-1.7\nSynthetic resume\n%%EOF");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sourceUrl = "https://careers.example.com/jobs/123";
const input = {
  to: "apply@example.com",
  subject: "Associate application",
  body: "Please find my resume attached.",
  sourceQuote: "To apply, email your resume to apply@example.com.",
  sourceUrl,
  expectedUpdatedAt: "2026-09-16T12:00:00.000Z",
};
const lease = { leaseOwner: "synthetic", leaseGeneration: 1 };
function harness() {
  const record = {
    id: recordId,
    userId: owner,
    identity: "example:123",
    url: sourceUrl,
    state: "eligible",
    updatedAt: new Date(input.expectedUpdatedAt),
    details: {
      posting: { descriptionText: input.sourceQuote, contentHash: "a".repeat(64), url: sourceUrl },
      verifiedEmployerCareerSource: {
        url: sourceUrl,
        postingContentHash: "a".repeat(64),
        verifiedAt: input.expectedUpdatedAt,
        evidence: { sourceUrl, quote: "Official employer careers", sha256: "b".repeat(64) },
      },
      document: { path: "/synthetic/resume.pdf", sha256 },
      preview: {
        readiness: "ready",
        renderReviewed: true,
        conflicts: [],
        pdfHash: sha256,
        manifestHash: "c".repeat(64),
      },
      previewAttachments: { attachments: [] },
      attachments: [],
      missingAnswers: [],
    } as Record<string, unknown>,
  };
  const attempt = {
    id: attemptId,
    userId: owner,
    recordId,
    mode: "submit",
    state: "prepared",
    submitAt: null as Date | null,
    updatedAt: new Date(),
    manifest: {} as Record<string, unknown>,
    receipt: null as unknown,
    leaseOwner: lease.leaseOwner,
    leaseGeneration: 1,
  };
  const events: string[] = [];
  let connected = true;
  let active = false;
  let optimistic = true;
  const prisma = {
    $queryRaw: async () => [{ id: owner }],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    personalRecord: {
      findFirst: async ({ where }: { where: { userId: string; id: string } }) =>
        where.userId === owner && where.id === recordId ? structuredClone(record) : null,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (!optimistic) return { count: 0 };
        Object.assign(record, data, { updatedAt: new Date() });
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(record, data);
        return record;
      },
    },
    personalAttempt: {
      findFirst: async ({ where }: { where: { userId: string; id?: string } }) =>
        where.id
          ? where.userId === owner && where.id === attemptId
            ? structuredClone(attempt)
            : null
          : active
            ? structuredClone(attempt)
            : null,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(attempt, data, { updatedAt: new Date() });
        events.push("receipt");
        return { count: 1 };
      },
    },
  };
  const attempts = {
    freezeEmailTransport: async (_user: string, _id: string, _lease: unknown, freeze: unknown) => {
      events.push("freeze");
      attempt.receipt = { emailTransport: freeze };
    },
    beginSubmit: async () => {
      events.push("begin");
      attempt.state = "submitting";
      attempt.submitAt = new Date();
      return attempt;
    },
  };
  const transport = {
    preflight: async () => {
      events.push("preflight");
      return connected
        ? { status: "ready", provider: "gmail", from: "candidate@example.net" }
        : { status: "blocked", reason: "Connect Gmail" };
    },
    sendPrepared: async () => {
      events.push("send");
      return {
        status: "provider_accepted",
        providerMessageId: "sent",
        threadId: "thread",
        employerAcknowledged: false,
        canResend: false,
      };
    },
    lookupSent: async () => {
      events.push("lookup");
      return {
        status: "provider_sent_verified",
        providerMessageId: "sent",
        threadId: "thread",
        employerAcknowledged: false,
        canResend: false,
      };
    },
  };
  class SyntheticService extends PersonalApplicationEmailService {
    protected override async readPdf() {
      return bytes;
    }
  }
  const service = new SyntheticService(
    prisma as unknown as PrismaClient,
    attempts as unknown as PersonalAttemptService,
    transport as unknown as ApplicationEmailTransportService,
  );
  return {
    service,
    record,
    attempt,
    events,
    transport,
    disconnect: () => {
      connected = false;
    },
    active: () => {
      active = true;
    },
    race: () => {
      optimistic = false;
    },
    async prepare() {
      const result = await service.prepare(owner, recordId, input);
      attempt.manifest.applicationEmailHash = result.payload.payloadHash;
      return result;
    },
  };
}

describe("official application email orchestration", () => {
  it("stores the authored immutable draft with exact current PDF metadata", async () => {
    const h = harness();
    const result = await h.prepare();
    expect(result.payload.body).toBe(input.body);
    expect(result.payload.attachments[0]?.sha256).toBe(sha256);
    expect(h.record.details.applicationEmail).toEqual(result.payload);
    expect(h.record.details.applicationEmailHistory).toHaveLength(1);
    expect(h.events).toEqual([]);
  });
  it("refuses stale, unowned or active draft replacement", async () => {
    const h = harness();
    await expect(h.service.prepare("foreign", recordId, input)).rejects.toThrow();
    await expect(
      h.service.prepare(owner, recordId, { ...input, expectedUpdatedAt: "2025-01-01T00:00:00Z" }),
    ).rejects.toThrow();
    h.active();
    await expect(h.service.prepare(owner, recordId, input)).rejects.toThrow();
    const raced = harness();
    raced.race();
    await expect(raced.prepare()).rejects.toThrow();
  });
  it("blocks missing OAuth before freeze or beginSubmit", async () => {
    const h = harness();
    await h.prepare();
    h.disconnect();
    const result = await h.service.dispatch(owner, attemptId, lease);
    expect(result.status).toBe("blocked");
    expect(h.events).toEqual(["preflight"]);
    expect(h.attempt.submitAt).toBeNull();
  });
  it("freezes and begins before send, retaining provider receipt as uncertain", async () => {
    const h = harness();
    await h.prepare();
    const result = await h.service.dispatch(owner, attemptId, lease);
    expect(h.events).toEqual(["preflight", "freeze", "begin", "send", "receipt"]);
    expect(result.status).toBe("provider_accepted");
    expect(result.attemptState).toBe("submission_uncertain");
    expect(result.employerAcknowledged).toBe(false);
    expect((h.attempt.receipt as Record<string, unknown>).emailTransport).toBeDefined();
    expect((h.attempt.receipt as Record<string, unknown>).emailProviderReceipt).toBeDefined();
    expect(h.record.state).toBe("submission_uncertain");
  });
  it("does not send changed body, source or manifest after preparation", async () => {
    const h = harness();
    await h.prepare();
    h.attempt.manifest.applicationEmailHash = manifestHash("different");
    await expect(h.service.dispatch(owner, attemptId, lease)).rejects.toThrow();
    expect(h.events).not.toContain("send");
    const body = harness();
    await body.prepare();
    (body.record.details.applicationEmail as Record<string, unknown>).body = "A changed claim";
    await expect(body.service.dispatch(owner, attemptId, lease)).rejects.toThrow();
    expect(body.events).not.toContain("begin");
    const source = harness();
    await source.prepare();
    (source.record.details.posting as Record<string, unknown>).descriptionText =
      "Applications have closed.";
    await expect(source.service.dispatch(owner, attemptId, lease)).rejects.toThrow();
    expect(source.events).not.toContain("begin");
  });
  it("retains uncertainty when transport fails after the durable begin boundary", async () => {
    const h = harness();
    await h.prepare();
    h.transport.sendPrepared = async () => {
      h.events.push("send");
      throw new Error("synthetic failure");
    };
    const result = await h.service.dispatch(owner, attemptId, lease);
    expect(result.status).toBe("uncertain");
    expect(result.attemptState).toBe("submission_uncertain");
    expect(h.events.filter((event) => event === "send")).toHaveLength(1);
    await expect(h.service.dispatch(owner, attemptId, lease)).rejects.toThrow();
  });
  it("never downgrades an independent employer-confirmed submission during Sent lookup", async () => {
    const h = harness();
    await h.prepare();
    await h.service.dispatch(owner, attemptId, lease);
    h.attempt.state = "submitted";
    h.record.state = "submitted";
    const result = await h.service.reconcileEmail(owner, attemptId);
    expect(result.attemptState).toBe("submitted");
    expect(h.record.state).toBe("submitted");
  });
  it("reconciles Sent without claiming employer acknowledgement or authorizing retry", async () => {
    const h = harness();
    await h.prepare();
    await h.service.dispatch(owner, attemptId, lease);
    const result = await h.service.reconcileEmail(owner, attemptId);
    expect(result.status).toBe("provider_sent_verified");
    expect(result.attemptState).toBe("submission_uncertain");
    expect(result.canResend).toBe(false);
    expect(result.employerAcknowledged).toBe(false);
    expect(h.events.filter((event) => event === "send")).toHaveLength(1);
  });
});
