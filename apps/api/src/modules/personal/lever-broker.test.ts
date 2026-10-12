import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalBrowserBroker } from "../../../../../plugin/scripts/personal-browser/core";
import { LeverDriver } from "../../../../../plugin/scripts/personal-browser/lever-driver";
import {
  parseLeverIdentity,
  readLeverFrozenRequest,
} from "../../../../../plugin/scripts/personal-browser/lever-network";
import { manifestHash } from "./persistence-policy";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const posting = "https://jobs.lever.co/synthetic/44444444-4444-4444-8444-444444444444";
const identity = "lever:global:synthetic:44444444-4444-4444-8444-444444444444";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(mode: "accepted" | "challenge" | "reject_freeze" | "approval_revoked") {
  const root = await mkdtemp(join(tmpdir(), "lever-broker-synthetic-"));
  const userRoot = join(root, "storage", userId);
  await mkdir(userRoot, { recursive: true });
  const document = join(userRoot, "resume.pdf");
  await writeFile(document, "%PDF-synthetic-only", { mode: 0o600 });
  const events: string[] = [];
  const manifest = {
    identity,
    canonicalUrl: posting,
    applicantEmail: "synthetic@example.test",
    document: { path: document, sha256: hash("%PDF-synthetic-only") },
    answers: [{ key: "email", fieldName: "email", value: "synthetic@example.test" }],
  };
  let state = "preparing";
  let frozen: Record<string, unknown> | undefined;
  let receipt: Record<string, unknown> | undefined;
  const driver = new LeverDriver({
    transport: async (request) => {
      if (request.method === "GET")
        return new Response(
          `<!doctype html><html><body>
      <h1>Synthetic Associate</h1><form action="${posting}/apply" method="POST" enctype="multipart/form-data">
      <label>Email<input name="email" type="email" required></label>
      <label>Resume<input name="resume" type="file" required></label>
      <button type="submit">Submit application</button></form></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      if (!frozen) throw new Error("Synthetic transport refused POST before API freeze");
      events.push("employer-post");
      return mode === "challenge"
        ? Response.json(
            { code: "captcha-failed", security_code_recipient: "synthetic@example.test" },
            { status: 422 },
          )
        : new Response(
            "<h1>Application received</h1><p>Synthetic Associate</p><p>synthetic@example.test</p>",
            { headers: { "content-type": "text/html" } },
          );
    },
  });
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace("/api/personal", "");
    if (req.headers.get("authorization") !== "Bearer synthetic-pat")
      return new Response(null, { status: 401 });
    events.push(`${req.method}:${path}`);
    if (req.method === "GET" && path === `/attempts/${attemptId}`)
      return Response.json({
        id: attemptId,
        userId,
        recordId,
        mode: "submit",
        state,
        manifest,
        manifestHash: manifestHash(manifest),
        leaseOwner: "synthetic-worker",
        leaseGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      });
    if (req.method === "GET" && path === `/${recordId}`)
      return Response.json({
        id: recordId,
        title: "Synthetic Associate",
        url: posting,
        identity,
        requisitionId: "44444444-4444-4444-8444-444444444444",
      });
    if (req.method !== "POST") return new Response(null, { status: 404 });
    const body = await req.json();
    if (path.endsWith("/authorize-transmission"))
      return Response.json(
        { authorized: mode !== "approval_revoked" },
        { status: mode === "approval_revoked" ? 409 : 200 },
      );
    if (path.endsWith("/prepare")) {
      state = "prepared";
      return Response.json({ state });
    }
    if (path.endsWith("/begin-submit")) {
      state = "submitting";
      return Response.json({ state });
    }
    if (path.endsWith("/hosted-transport/freeze")) {
      expect(state).toBe("submitting");
      expect(body.leaseGeneration).toBe(1);
      if (mode === "reject_freeze") return new Response(null, { status: 409 });
      const bytes = await readFile(join(userRoot, "challenges", `${body.evidenceHash}.json`));
      expect(hash(bytes)).toBe(body.evidenceHash);
      const artifact = JSON.parse(bytes.toString());
      expect(artifact).toMatchObject({
        kind: "lever_submission_payload",
        attemptId,
        manifestHash: manifestHash(manifest),
        targetUrl: `${posting}/apply`,
      });
      const proof = await readLeverFrozenRequest(
        artifact.requestBody,
        parseLeverIdentity(posting, identity),
        artifact.targetUrl,
      );
      frozen = { ...artifact, ...proof };
      return Response.json({ attemptId, status: "frozen", ...proof });
    }
    if (path.endsWith("/receipt")) {
      receipt = body.evidence;
      expect(receipt?.outcome).toBe("uncertain");
      state = "submission_uncertain";
      return Response.json({ id: attemptId, state });
    }
    throw new Error(`Unexpected synthetic API route ${path}`);
  }) as typeof fetch;
  const broker = new PersonalBrowserBroker(
    {
      api: "http://127.0.0.1:49231",
      token: "synthetic-pat",
      attemptId,
      leaseOwner: "synthetic-worker",
      leaseGeneration: 1,
      root,
    },
    driver,
    request,
  );
  return {
    broker,
    events,
    state: () => state,
    receipt: () => receipt,
    frozen: () => frozen,
    async close() {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Lever broker integration without external network", () => {
  test("revoked application approval prevents hosted field transmission", async () => {
    const f = await fixture("approval_revoked");
    try {
      const form = await f.broker.inspectForm();
      const email = form.fields.find((field) => field.type === "email")!;
      await expect(f.broker.fillField(email.ref, email.answerKey!)).rejects.toThrow("API refused");
      expect(f.frozen()).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  test.each([
    "accepted",
    "challenge",
    "reject_freeze",
  ] as const)("requires Lever freeze and retains uncertainty after %s", async (mode) => {
    const f = await fixture(mode);
    try {
      const form = await f.broker.inspectForm();
      const email = form.fields.find((field) => field.type === "email")!;
      const resume = form.fields.find((field) => field.resumeUpload)!;
      await f.broker.fillField(email.ref, email.answerKey!);
      await f.broker.uploadResume(resume.ref);
      const result = await f.broker.submitApplication();
      expect(result.status).toBe("submission_uncertain");
      expect(f.state()).toBe("submission_uncertain");
      const begin = f.events.indexOf(`POST:/attempts/${attemptId}/begin-submit`);
      const freeze = f.events.indexOf(`POST:/attempts/${attemptId}/hosted-transport/freeze`);
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(freeze).toBeGreaterThan(begin);
      expect(f.events.some((event) => event.includes("/challenge"))).toBe(false);
      if (mode === "reject_freeze") expect(f.events).not.toContain("employer-post");
      else {
        expect(f.events.indexOf("employer-post")).toBeGreaterThan(freeze);
        const receipt = JSON.parse(await readFile(String(f.receipt()?.artifactPath), "utf8"));
        expect(receipt.transport.requestBodyHash).toBe(f.frozen()?.requestBodyHash);
        expect(receipt.transport.applicationPayloadHash).toBe(f.frozen()?.applicationPayloadHash);
      }
      await expect(f.broker.submitApplication()).rejects.toThrow();
      expect(f.events.filter((event) => event === "employer-post")).toHaveLength(
        mode === "reject_freeze" ? 0 : 1,
      );
    } finally {
      await f.close();
    }
  }, 20_000);
});
