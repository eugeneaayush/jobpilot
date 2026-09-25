import "reflect-metadata";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  parseLeverIdentity,
  validateLeverFinalRequest,
} from "../../../../../plugin/scripts/personal-browser/lever-network";
import type { PersonalAttemptService } from "./attempt.service";
import { PersonalHostedTransportService } from "./hosted-transport.service";
import { manifestHash } from "./persistence-policy";
import { describe, expect, test } from "bun:test";

const userId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const attemptId = "30000000-0000-4000-8000-000000000001";
const job = "40000000-0000-4000-8000-000000000001";
const identity = `lever:global:synthetic:${job}`;
const url = `https://jobs.lever.co/synthetic/${job}`;
const lease = { leaseOwner: "synthetic-broker", leaseGeneration: 2 };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function harness() {
  const record = {
    id: recordId,
    userId,
    identity,
    url,
    state: "applying",
    details: {
      posting: { source: "lever", sourceRegion: "global", boardToken: "synthetic", nativeId: job },
    },
  };
  const attempt = {
    id: attemptId,
    userId,
    recordId,
    mode: "submit",
    state: "submitting",
    ...lease,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    submitAt: new Date(Date.now() - 1_000) as Date | null,
    updatedAt: new Date(),
    manifest: { identity, canonicalUrl: url },
    manifestHash: "",
    receipt: { priorEvidence: { retained: true } } as Record<string, unknown>,
  };
  attempt.manifestHash = manifestHash(attempt.manifest);
  const form = new FormData();
  form.set("email", "synthetic@example.test");
  const req = new Request(`${url}/apply`, { method: "POST", body: form });
  const wire = await validateLeverFinalRequest(
    {
      targetUrl: req.url,
      contentType: req.headers.get("content-type")!,
      body: Buffer.from(await req.arrayBuffer()),
    },
    parseLeverIdentity(url, identity),
    {
      fields: [{ name: "email", type: "email", required: true, value: "", choices: [] }],
      approved: { email: "synthetic@example.test" },
      files: {},
      hidden: {},
    },
  );
  const envelope = {
    schemaVersion: 1,
    kind: "lever_submission_payload",
    attemptId,
    manifestHash: attempt.manifestHash,
    targetUrl: `${url}/apply`,
    requestBody: wire.frozenRequest,
    capturedAt: new Date().toISOString(),
  };
  let bytes = Buffer.from(JSON.stringify(envelope));
  let saves = 0;
  let race = false;
  let rejectManifest = false;
  const events: string[] = [];
  const prisma = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    $queryRaw: async () => {
      events.push("lock");
      return [{ id: userId }];
    },
    personalAttempt: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === attemptId && where.userId === userId ? structuredClone(attempt) : null,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (race) return { count: 0 };
        saves++;
        Object.assign(attempt, data);
        events.push("save");
        return { count: 1 };
      },
    },
    personalRecord: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === recordId && where.userId === userId ? structuredClone(record) : null,
    },
  };
  const attempts = {
    verifyContinuationManifest: async () => {
      events.push("manifest");
      if (rejectManifest) throw new Error("changed policy");
    },
  };
  class SyntheticService extends PersonalHostedTransportService {
    protected override async readArtifact() {
      events.push("artifact");
      return bytes;
    }
  }
  const service = new SyntheticService(
    prisma as unknown as PrismaClient,
    attempts as unknown as PersonalAttemptService,
  );
  return {
    attempt,
    record,
    envelope,
    wire,
    events,
    saves: () => saves,
    race: () => {
      race = true;
    },
    rejectManifest: () => {
      rejectManifest = true;
    },
    artifact: (change: Record<string, unknown>) => {
      Object.assign(envelope, change);
      bytes = Buffer.from(JSON.stringify(envelope));
    },
    freeze: (owner = userId, input: Record<string, unknown> = {}) =>
      service.freeze(owner, attemptId, { ...lease, evidenceHash: digest(bytes), ...input }),
  };
}

describe("Lever hosted transport freeze", () => {
  test("locks and rechecks the manifest before preserving exact immutable request hashes", async () => {
    const h = await harness();
    const result = await h.freeze();
    expect(result.provider).toBe("lever");
    expect(result.status).toBe("frozen");
    expect(result.requestBodyHash).toBe(h.wire.requestBodyHash);
    expect(result.applicationPayloadHash).toBe(h.wire.applicationPayloadHash);
    expect(result.capturedAt).toBeInstanceOf(Date);
    expect(h.events).toEqual(["lock", "manifest", "artifact", "save"]);
    expect(h.attempt.receipt.priorEvidence).toEqual({ retained: true });
    expect(h.attempt.state).toBe("submitting");
    expect(JSON.stringify(result)).not.toContain("synthetic@example.test");
    expect(await h.freeze()).toEqual(result);
    expect(h.saves()).toBe(1);
    h.artifact({ capturedAt: new Date(Date.now() + 1).toISOString() });
    await expect(h.freeze()).rejects.toThrow("immutable");
  });
  test("rejects unowned, stale, expired, or unbegun attempts", async () => {
    const h = await harness();
    await expect(h.freeze("foreign")).rejects.toThrow();
    await expect(h.freeze(userId, { leaseGeneration: 1 })).rejects.toThrow();
    await expect(h.freeze(userId, { leaseOwner: "other" })).rejects.toThrow();
    h.attempt.leaseExpiresAt = new Date(0);
    await expect(h.freeze()).rejects.toThrow();
    h.attempt.leaseExpiresAt = new Date(Date.now() + 60_000);
    h.attempt.submitAt = null;
    await expect(h.freeze()).rejects.toThrow();
    expect(h.saves()).toBe(0);
  });
  test.each([
    "prepared",
    "submission_uncertain",
    "submitted",
  ])("rejects attempt state %s", async (state) => {
    const h = await harness();
    h.attempt.state = state;
    await expect(h.freeze()).rejects.toThrow();
    expect(h.saves()).toBe(0);
  });
  test("rejects mutated manifest, changed policy, and optimistic concurrency conflicts", async () => {
    const changed = await harness();
    changed.attempt.manifest.identity = "changed";
    await expect(changed.freeze()).rejects.toThrow();
    const policy = await harness();
    policy.rejectManifest();
    await expect(policy.freeze()).rejects.toThrow();
    expect(policy.events).not.toContain("artifact");
    const race = await harness();
    race.race();
    await expect(race.freeze()).rejects.toThrow();
    expect(race.saves()).toBe(0);
  });
  test.each([
    { source: "greenhouse" },
    { sourceRegion: "eu" },
    { boardToken: "other" },
    { nativeId: "other" },
  ])("rejects changed discovered source identity %j", async (change) => {
    const h = await harness();
    Object.assign(h.record.details.posting, change);
    await expect(h.freeze()).rejects.toThrow();
    expect(h.saves()).toBe(0);
  });
  test.each([
    { kind: "greenhouse_submission_payload" },
    { attemptId: recordId },
    { manifestHash: "0".repeat(64) },
    { targetUrl: `${url}/other` },
    { capturedAt: "2020-01-01T00:00:00.000Z" },
    { capturedAt: "2099-01-01T00:00:00.000Z" },
    { unexpected: "field" },
  ])("rejects invalid artifact boundary %j", async (change) => {
    const h = await harness();
    h.artifact(change);
    await expect(h.freeze()).rejects.toThrow();
    expect(h.saves()).toBe(0);
  });
  test("rejects changed artifact SHA or request digests", async () => {
    const h = await harness();
    await expect(h.freeze(userId, { evidenceHash: "0".repeat(64) })).rejects.toThrow();
    const wire = JSON.parse(h.envelope.requestBody);
    wire.applicationPayloadHash = "0".repeat(64);
    h.artifact({ requestBody: JSON.stringify(wire) });
    await expect(h.freeze()).rejects.toThrow();
    expect(h.saves()).toBe(0);
  });
});
