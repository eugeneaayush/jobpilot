import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueGreenhouseVerification } from "../../../../../plugin/scripts/personal-browser/greenhouse-continuation";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const permitId = "44444444-4444-4444-8444-444444444444";
const code = "Ab12Cd34";
const target = "https://boards.greenhouse.io/synthetic/jobs/123";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown, codepoint = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item, codepoint));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          if (!codepoint) return a.localeCompare(b);
          if (a < b) return -1;
          return a > b ? 1 : 0;
        })
        .map(([key, item]) => [key, stable(item, codepoint)]),
    );
  return value;
}
type Mode =
  | "accepted"
  | "challenge"
  | "timeout"
  | "receipt_lost"
  | "reconcile_mismatch"
  | "consume_lost"
  | "stopped"
  | "changed_files"
  | "html"
  | "wrong_url";
async function fixture(mode: Mode = "accepted") {
  const root = await mkdtemp(join(tmpdir(), "greenhouse-continuation-synthetic-"));
  const directory = join(root, "storage", userId, "challenges");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    identity: "greenhouse:synthetic:123",
    answers: [{ fieldName: "email", value: "synthetic@example.test" }],
    document: { sha256: hash("synthetic-document") },
  };
  const manifestHash = hash(JSON.stringify(stable(manifest)));
  const application = {
    email: "synthetic@example.test",
    resume_url: "https://synthetic.invalid/frozen-file",
    resume_url_filename: "synthetic.pdf",
    nested: { a: 1, A: 2, _: 3 },
  };
  const requestBody = JSON.stringify({
    job_application: application,
    fingerprint: "synthetic-fingerprint",
    "g-recaptcha-enterprise-token": "prior-site-token",
  });
  const originalArtifact = {
    schemaVersion: 1,
    kind: "greenhouse_submission_payload",
    attemptId,
    manifestHash,
    targetUrl: target,
    requestBody,
    capturedAt: new Date().toISOString(),
  };
  const originalBytes = JSON.stringify(originalArtifact, null, 2);
  const originalHash = hash(originalBytes);
  await writeFile(join(directory, `${originalHash}.json`), originalBytes, { mode: 0o600 });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const scope = {
    attemptId,
    transport: {
      manifestHash,
      targetUrl: target,
      applicationPayloadHash: hash(JSON.stringify(stable(application, true))),
      requestBodyHash: hash(requestBody),
      evidenceHash: originalHash,
    },
    challenge: {
      challengeId,
      code: "captcha-failed",
      status: "awaiting_user",
      hasRecipient: true,
      leaseOwner: null as string | null,
      leaseGeneration: 0,
      leaseExpiresAt: null as string | null,
      permit: null as {
        permitId: string;
        status: string;
        expiresAt: string;
        requestBodyHash: string;
        evidenceHash: string;
      } | null,
    },
  };
  const events: string[] = [];
  const apiBodies: unknown[] = [];
  const employer: { url: string; init: RequestInit }[] = [];
  const reconciliations: Record<string, unknown>[] = [];
  let challenges = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const parsed = new URL(url);
    events.push(`${init.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.hostname !== "127.0.0.1") {
      employer.push({ url, init });
      if (mode === "timeout") throw new Error(`Synthetic timeout ${code}`);
      let response = Response.json({});
      if (mode === "challenge")
        response = Response.json({ code: "invalid-security-code" }, { status: 422 });
      if (mode === "html")
        response = new Response("<h1>Thank you for applying</h1>", {
          headers: { "content-type": "text/html" },
        });
      Object.defineProperty(response, "url", {
        value: mode === "wrong_url" ? `${target}/confirmation` : target,
      });
      return response;
    }
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-local-token");
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    if (body) apiBodies.push(body);
    if (parsed.pathname === `/api/personal/attempts/${attemptId}`)
      return Response.json({
        id: attemptId,
        userId,
        manifestHash,
        manifest,
        mode: "submit",
        state: "submission_uncertain",
        submitAt: new Date().toISOString(),
      });
    if (parsed.pathname.endsWith("/challenge") && init.method === "GET")
      return Response.json(scope);
    if (parsed.pathname.endsWith("/lease")) {
      scope.challenge.status = "leased";
      scope.challenge.leaseOwner = String(body?.leaseOwner);
      scope.challenge.leaseGeneration = 2;
      scope.challenge.leaseExpiresAt = expiresAt;
      return Response.json(scope);
    }
    if (parsed.pathname.endsWith("/continue")) {
      const bytes = await readFile(join(directory, `${body?.evidenceHash}.json`), "utf8");
      expect(hash(bytes)).toBe(String(body?.evidenceHash));
      const next = JSON.parse(bytes) as { requestBody: string };
      scope.challenge.status = "permitted";
      scope.challenge.permit = {
        permitId,
        status: "issued",
        expiresAt,
        requestBodyHash: hash(next.requestBody),
        evidenceHash: String(body?.evidenceHash),
      };
      return Response.json(scope);
    }
    if (parsed.pathname.endsWith("/consume")) {
      if (mode === "stopped" || mode === "changed_files")
        return Response.json({ error: "Synthetic authority changed" }, { status: 409 });
      scope.challenge.status = "continuing";
      if (!scope.challenge.permit) throw new Error("Missing synthetic permit");
      scope.challenge.permit.status = "consumed";
      if (mode === "consume_lost") throw new Error("Synthetic consumed reply lost");
      return Response.json(scope);
    }
    if (parsed.pathname.endsWith("/challenge") && init.method === "POST") {
      challenges += 1;
      return Response.json({
        ...scope,
        challenge: { ...scope.challenge, status: "awaiting_user" },
      });
    }
    if (parsed.pathname.endsWith("/reconcile")) {
      reconciliations.push(body ?? {});
      if (mode === "receipt_lost") throw new Error("Synthetic receipt reply lost");
      const evidence = body?.evidence as { outcome: string };
      return Response.json({
        id: mode === "reconcile_mismatch" ? userId : attemptId,
        state: evidence.outcome === "submitted" ? "submitted" : "submission_uncertain",
      });
    }
    throw new Error("Unexpected synthetic API route");
  };
  return {
    root,
    directory,
    scope,
    events,
    apiBodies,
    employer,
    reconciliations,
    originalHash,
    application,
    challenges: () => challenges,
    run: (input = { attemptId, challengeId, code }) =>
      continueGreenhouseVerification(
        {
          api: "http://127.0.0.1:4199",
          token: "synthetic-local-token",
          root,
          leaseOwner: "synthetic-user",
        },
        input,
        { fetch },
      ),
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function rejection(action: () => Promise<unknown>) {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(code);
}

describe("private user email verification continuation", () => {
  test("consumes one permit before one exact frozen application POST and reconciles its private receipt", async () => {
    const f = await fixture();
    try {
      const result = await f.run();
      expect(result.status).toBe("submitted");
      expect(f.employer).toHaveLength(1);
      const sent = f.employer[0];
      if (!sent) throw new Error("Missing synthetic request");
      expect(sent.url).toBe(target);
      expect(sent.init.redirect).toBe("error");
      expect(new Headers(sent.init.headers).get("authorization")).toBeNull();
      expect(new Headers(sent.init.headers).get("origin")).toBe("https://job-boards.greenhouse.io");
      expect(new Headers(sent.init.headers).get("referer")).toBe(
        "https://job-boards.greenhouse.io/synthetic/jobs/123",
      );
      expect(JSON.parse(String(sent.init.body))).toEqual({
        job_application: f.application,
        fingerprint: "synthetic-fingerprint",
        security_code: code,
      });
      expect(
        f.events.indexOf(`POST /api/personal/attempts/${attemptId}/challenge/consume`),
      ).toBeLessThan(f.events.indexOf("POST /synthetic/jobs/123"));
      expect(f.reconciliations).toHaveLength(1);
      expect(f.reconciliations[0]).toMatchObject({
        evidence: { outcome: "submitted", kind: "ats_status", sourceUrl: target },
      });
      expect(JSON.stringify(f.apiBodies)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain(code);
      if (!result.receiptHash) throw new Error("Missing synthetic receipt hash");
      const receipt = join(f.directory, `${result.receiptHash}.json`);
      expect(hash(await readFile(receipt, "utf8"))).toBe(result.receiptHash);
      expect((await stat(receipt)).mode & 0o777).toBe(0o600);
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
      await rejection(() => f.run());
      expect(f.employer).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  for (const mode of ["stopped", "changed_files"] as const)
    test(`${mode} before consume sends no employer request`, async () => {
      const f = await fixture(mode);
      try {
        await rejection(() => f.run());
        expect(f.employer).toHaveLength(0);
        expect(f.reconciliations).toHaveLength(0);
      } finally {
        await f.close();
      }
    });
  for (const mode of [
    "timeout",
    "receipt_lost",
    "consume_lost",
    "wrong_url",
    "reconcile_mismatch",
  ] as const)
    test(`${mode} remains uncertain with no automatic retry`, async () => {
      const f = await fixture(mode);
      try {
        const result = await f.run();
        expect(result.status).toBe("submission_uncertain");
        expect(f.employer).toHaveLength(mode === "consume_lost" ? 0 : 1);
        expect(f.events.filter((event) => event.endsWith("/consume"))).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(code);
        expect(f.challenges()).toBe(0);
      } finally {
        await f.close();
      }
    });
  test("known invalid code creates a same-attempt challenge without reconciliation or replay", async () => {
    const f = await fixture("challenge");
    try {
      const result = await f.run();
      expect(result.status).toBe("submission_uncertain");
      expect(f.employer).toHaveLength(1);
      expect(f.challenges()).toBe(1);
      expect(f.reconciliations).toHaveLength(0);
      const receipt = JSON.parse(
        await readFile(join(f.directory, `${result.receiptHash}.json`), "utf8"),
      );
      expect(receipt).toMatchObject({
        kind: "greenhouse_post_submit_challenge",
        attemptId,
        challengeId,
        permitId,
        targetUrl: target,
        responseStatus: 422,
      });
    } finally {
      await f.close();
    }
  });
  test("a public HTML confirmation response cannot prove acceptance", async () => {
    const f = await fixture("html");
    try {
      expect((await f.run()).status).toBe("submission_uncertain");
      expect(f.reconciliations[0]).toMatchObject({ evidence: { outcome: "uncertain" } });
    } finally {
      await f.close();
    }
  });
  test("CAPTCHA retry and malformed user codes never acquire continuation authority", async () => {
    const f = await fixture();
    try {
      await rejection(() => f.run({ attemptId, challengeId, code: "short" }));
      expect(f.events).toHaveLength(0);
      f.scope.challenge.code = "captcha-retry";
      await rejection(() => f.run());
      expect(f.events.some((event) => event.endsWith("/lease"))).toBe(false);
      expect(f.employer).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  test("changed frozen bytes or destination are rejected before acquiring a lease", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.directory, `${f.originalHash}.json`), "changed synthetic bytes");
      await rejection(() => f.run());
      expect(f.events.some((event) => event.endsWith("/lease"))).toBe(false);
      f.scope.transport.targetUrl = "https://boards.greenhouse.io/synthetic/jobs/124";
      await rejection(() => f.run());
      expect(f.employer).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  test("nonloopback API configuration cannot transmit the supplied code or credential", async () => {
    let calls = 0;
    await rejection(() =>
      continueGreenhouseVerification(
        { api: "https://example.test", token: "synthetic", root: "/synthetic" },
        { attemptId, challengeId, code },
        {
          fetch: async () => {
            calls += 1;
            throw new Error("Unexpected request");
          },
        },
      ),
    );
    expect(calls).toBe(0);
  });
});
