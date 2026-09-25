import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersonalChallengeService } from "./challenge.service";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!url)("post-submit challenge persistence", () => {
  let db: PersonalTestDatabase;
  let service: PersonalChallengeService;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(url!);
    service = new PersonalChallengeService(db.prisma, db.service);
  });
  afterAll(async () => {
    await db?.dispose();
  });
  async function artifact(userId: string, value: unknown) {
    const bytes = JSON.stringify(value);
    const evidenceHash = sha256(bytes);
    const dir = join(db.root, "storage", userId, "challenges");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${evidenceHash}.json`), bytes, { mode: 0o600 });
    return { evidenceHash };
  }
  async function fixture(parkBeforeRegistration = false) {
    const f = await personalFixture(db);
    const { record, input } = await f.record(
      "123",
      "https://boards.greenhouse.io/synthetic/jobs/123",
    );
    const started = await db.service.start(f.user.id, input);
    await db.service.prepare(f.user.id, started.id, started);
    const attempt = await db.service.beginSubmit(f.user.id, started.id, started);
    const payload = {
      schemaVersion: 1,
      kind: "greenhouse_submission_payload",
      attemptId: attempt.id,
      manifestHash: attempt.manifestHash,
      targetUrl: record.url,
      requestBody: JSON.stringify({
        job_application: { first_name: "Synthetic", answers: { consent: true } },
        fingerprint: "synthetic-fingerprint",
        "g-recaptcha-enterprise-token": "opaque-token",
      }),
      capturedAt: new Date().toISOString(),
    };
    const proof = await artifact(f.user.id, payload);
    const frozen = await service.freeze(f.user.id, attempt.id, { ...attempt, ...proof });
    const response = {
      schemaVersion: 1,
      kind: "greenhouse_post_submit_challenge",
      attemptId: attempt.id,
      manifestHash: attempt.manifestHash,
      targetUrl: record.url,
      requestBodyHash: frozen.transport!.requestBodyHash,
      applicationPayloadHash: frozen.transport!.applicationPayloadHash,
      responseStatus: 422,
      responseBody: JSON.stringify({
        code: "captcha-failed",
        security_code_recipient: "synthetic@example.test",
      }),
      capturedAt: new Date().toISOString(),
    };
    if (parkBeforeRegistration)
      await db.service.park(
        f.user.id,
        attempt.id,
        attempt,
        "failed",
        "Synthetic worker interruption after transport freeze",
      );
    const responseProof = await artifact(f.user.id, response);
    const registered = await service.register(f.user.id, attempt.id, responseProof);
    return { ...f, record, attempt, payload, proof, response, responseProof, registered };
  }
  async function permit(f: Awaited<ReturnType<typeof fixture>>) {
    const leased = await service.lease(f.user.id, f.attempt.id, {
      challengeId: f.registered.challenge!.challengeId,
      leaseOwner: "synthetic-user-session",
      explicitUser: true,
    });
    const fence = {
      challengeId: leased.challenge!.challengeId,
      leaseOwner: leased.challenge!.leaseOwner!,
      leaseGeneration: leased.challenge!.leaseGeneration,
    };
    const body = JSON.parse(f.payload.requestBody);
    delete body["g-recaptcha-enterprise-token"];
    body.security_code = "12345678";
    const proof = await artifact(f.user.id, {
      ...f.payload,
      requestBody: JSON.stringify(body),
      capturedAt: new Date().toISOString(),
    });
    const permitted = await service.continue(f.user.id, f.attempt.id, {
      ...fence,
      ...proof,
      explicitUser: true,
    });
    return { fence, permitted, proof };
  }
  test("recognized challenge revokes worker and retains original attempt, quota and reservation", async () => {
    const f = await fixture();
    const attempt = await db.prisma.personalAttempt.findUniqueOrThrow({
      where: { id: f.attempt.id },
    });
    expect(attempt.state).toBe("submission_uncertain");
    expect(attempt.submitAt).toEqual(f.attempt.submitAt);
    expect(attempt.manifestHash).toBe(f.attempt.manifestHash);
    expect(attempt.leaseGeneration).toBeGreaterThan(f.attempt.leaseGeneration);
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
    expect(await db.prisma.personalAttempt.count({ where: { recordId: f.record.id } })).toBe(1);
    const replay = await service.register(f.user.id, attempt.id, f.responseProof);
    expect(replay.challenge!.challengeId).toBe(f.registered.challenge!.challengeId);
    await expect(db.service.cancel(f.user.id, attempt.id, f.attempt)).rejects.toThrow();
    await expect(
      db.service.reconcile(f.user.id, attempt.id, {
        outcome: "not_submitted",
        kind: "manual_review",
        artifactPath: f.artifactPath,
        sha256: db.hash,
        sourceUrl: f.record.url,
        capturedAt: new Date().toISOString(),
        details: "Challenge is not a new attempt authorization",
        manifestHash: attempt.manifestHash,
      }),
    ).rejects.toThrow("remains held");
  });
  test("one-use continuation is fenced across concurrent requests and repeated challenge remains same attempt", async () => {
    const f = await fixture();
    const p = await permit(f);
    const input = { ...p.fence, permitId: p.permitted.challenge!.permit!.permitId };
    const consumed = await Promise.allSettled([
      service.consume(f.user.id, f.attempt.id, input),
      service.consume(f.user.id, f.attempt.id, input),
    ]);
    expect(consumed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const nextProof = await artifact(f.user.id, {
      ...f.response,
      requestBodyHash: p.permitted.challenge!.permit!.requestBodyHash,
      responseBody: '{"code":"invalid-security-code"}',
      capturedAt: new Date().toISOString(),
    });
    const next = await service.register(f.user.id, f.attempt.id, nextProof);
    expect(next.challenge!.challengeId).not.toBe(f.registered.challenge!.challengeId);
    expect(next.challenge!.status).toBe("awaiting_user");
    expect(next.challenge!.hasRecipient).toBe(true);
    expect(await db.prisma.personalReservation.count({ where: { attemptId: f.attempt.id } })).toBe(
      1,
    );
    expect((await db.service.get(f.user.id, f.attempt.id)).submitAt).toEqual(f.attempt.submitAt);
  });
  test("correlated acceptance settles the same attempt and preserves the challenge audit", async () => {
    const f = await fixture();
    const p = await permit(f);
    const permitId = p.permitted.challenge!.permit!.permitId;
    await service.consume(f.user.id, f.attempt.id, { ...p.fence, permitId });
    const capturedAt = new Date().toISOString();
    const accepted = await artifact(f.user.id, {
      schemaVersion: 1,
      kind: "greenhouse_verification_response",
      attemptId: f.attempt.id,
      manifestHash: f.attempt.manifestHash,
      challengeId: p.fence.challengeId,
      permitId,
      targetUrl: f.response.targetUrl,
      applicationPayloadHash: f.response.applicationPayloadHash,
      requestBodyHash: p.permitted.challenge!.permit!.requestBodyHash,
      responseStatus: 200,
      responseBody: "{}",
      capturedAt,
    });
    const result = await db.service.reconcile(f.user.id, f.attempt.id, {
      outcome: "submitted",
      kind: "ats_status",
      artifactPath: join(
        db.root,
        "storage",
        f.user.id,
        "challenges",
        `${accepted.evidenceHash}.json`,
      ),
      sha256: accepted.evidenceHash,
      sourceUrl: f.response.targetUrl,
      capturedAt,
      details: "Synthetic correlated employer response",
      manifestHash: f.attempt.manifestHash,
    });
    expect(result.state).toBe("submitted");
    expect(result.submitAt).toEqual(f.attempt.submitAt);
    expect(objectValue(result.receipt).challengeLedger).toBeDefined();
    expect((await service.get(f.user.id, f.attempt.id)).challenge!.status).toBe("resolved");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: f.attempt.id } })).toBe(
      1,
    );
  });
  test("worker parking after transport freeze preserves the pin and accepts the delayed challenge", async () => {
    const f = await fixture(true);
    expect(f.registered.transport!.requestBodyHash).toBe(f.response.requestBodyHash);
    expect(f.registered.challenge!.status).toBe("awaiting_user");
    const attempt = await db.service.get(f.user.id, f.attempt.id);
    expect(attempt.state).toBe("submission_uncertain");
    expect(objectValue(attempt.receipt).challengeLedger).toBeDefined();
    expect(attempt.submitAt).toEqual(f.attempt.submitAt);
  });
  test("changed payload or stopped campaign cannot get a continuation permit", async () => {
    const f = await fixture();
    const leased = await service.lease(f.user.id, f.attempt.id, {
      challengeId: f.registered.challenge!.challengeId,
      leaseOwner: "owner",
      explicitUser: true,
    });
    const fence = {
      challengeId: leased.challenge!.challengeId,
      leaseOwner: "owner",
      leaseGeneration: leased.challenge!.leaseGeneration,
      explicitUser: true as const,
    };
    const changed = await artifact(f.user.id, {
      ...f.payload,
      requestBody: JSON.stringify({
        job_application: { first_name: "Changed" },
        fingerprint: "synthetic-fingerprint",
        security_code: "12345678",
      }),
      capturedAt: new Date().toISOString(),
    });
    await expect(
      service.continue(f.user.id, f.attempt.id, { ...fence, ...changed }),
    ).rejects.toThrow("original application");
    await db.prisma.campaign.update({
      where: { campaignId: f.campaign.campaignId },
      data: { status: "paused" },
    });
    await expect(
      service.continue(f.user.id, f.attempt.id, { ...fence, ...f.proof }),
    ).rejects.toThrow("active");
  });
  test("cross-user evidence and expired leases cannot reopen a held submission", async () => {
    const f = await fixture();
    const other = await personalFixture(db);
    await expect(service.get(other.user.id, f.attempt.id)).rejects.toThrow("not found");
    const p = await permit(f);
    const attempt = await db.prisma.personalAttempt.findUniqueOrThrow({
      where: { id: f.attempt.id },
    });
    const receipt = objectValue(attempt.receipt);
    const ledger = objectValue(receipt.challengeLedger);
    const current = objectValue(ledger.current);
    current.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await db.prisma.personalAttempt.update({
      where: { id: attempt.id },
      data: {
        receipt: JSON.parse(
          JSON.stringify({ ...receipt, challengeLedger: { ...ledger, current } }),
        ),
      },
    });
    const restarted = new PersonalChallengeService(db.prisma, db.service);
    expect((await restarted.get(f.user.id, attempt.id)).challenge!.status).toBe("expired");
    await expect(
      restarted.consume(f.user.id, attempt.id, {
        ...p.fence,
        permitId: p.permitted.challenge!.permit!.permitId,
      }),
    ).rejects.toThrow("expired");
    expect((await db.service.get(f.user.id, attempt.id)).state).toBe("submission_uncertain");
    expect(await db.prisma.personalReservation.count({ where: { attemptId: attempt.id } })).toBe(1);
  });
});
