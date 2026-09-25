import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { classifyGreenhouseResponse } from "./greenhouse-network";

interface Config {
  api: string;
  token: string;
  root: string;
  leaseOwner?: string;
}
interface Input {
  attemptId: string;
  challengeId: string;
  code: string;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Scope {
  attemptId: string;
  transport: {
    manifestHash: string;
    targetUrl: string;
    applicationPayloadHash: string;
    requestBodyHash: string;
    evidenceHash: string;
  };
  challenge: {
    challengeId: string;
    code: string;
    status: string;
    hasRecipient: boolean;
    leaseOwner: string | null;
    leaseGeneration: number;
    leaseExpiresAt: string | null;
    permit: {
      permitId: string;
      status: string;
      expiresAt: string;
      requestBodyHash: string;
      evidenceHash: string;
    } | null;
  };
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const hashPattern = /^[a-f\d]{64}$/;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const unavailable = () =>
  new Error("Email verification continuation is unavailable; review the private attempt.");
class ApiDenied extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function sorted(value: unknown, codepoint = false): unknown {
  if (Array.isArray(value)) return value.map((child) => sorted(child, codepoint));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          if (!codepoint) return a.localeCompare(b);
          if (a < b) return -1;
          return a > b ? 1 : 0;
        })
        .map(([key, child]) => [key, sorted(child, codepoint)]),
    );
  return value;
}
const stableHash = (value: unknown) => hash(JSON.stringify(sorted(value)));
function scope(value: unknown, input: Input): Scope {
  const root = object(value);
  const transport = object(root.transport);
  const challenge = object(root.challenge);
  if (
    root.attemptId !== input.attemptId ||
    challenge.challengeId !== input.challengeId ||
    !["manifestHash", "applicationPayloadHash", "requestBodyHash", "evidenceHash"].every(
      (key) => typeof transport[key] === "string" && hashPattern.test(transport[key] as string),
    ) ||
    typeof transport.targetUrl !== "string" ||
    typeof challenge.status !== "string" ||
    typeof challenge.code !== "string" ||
    typeof challenge.hasRecipient !== "boolean"
  )
    throw unavailable();
  return value as Scope;
}
function fence(current: Scope, initial: Scope, leaseOwner: string, status: string) {
  const challenge = current.challenge;
  if (
    stableHash(current.transport) !== stableHash(initial.transport) ||
    challenge.status !== status ||
    challenge.leaseOwner !== leaseOwner ||
    !Number.isInteger(challenge.leaseGeneration) ||
    challenge.leaseGeneration < 1 ||
    !challenge.leaseExpiresAt ||
    Date.parse(challenge.leaseExpiresAt) <= Date.now() ||
    !Number.isFinite(Date.parse(challenge.leaseExpiresAt))
  )
    throw unavailable();
  return {
    challengeId: challenge.challengeId,
    leaseOwner,
    leaseGeneration: challenge.leaseGeneration,
  };
}
async function boundedText(response: Response, limit: number) {
  if (Number(response.headers.get("content-length") ?? "0") > limit) throw unavailable();
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw unavailable();
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function privateDirectory(root: string, userId: string) {
  const canonical = await realpath(root);
  let directory = canonical;
  for (const part of ["storage", userId, "challenges"]) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const actual = await realpath(directory);
    const within = relative(canonical, actual);
    if (!within || within.startsWith("..") || isAbsolute(within) || actual !== directory)
      throw unavailable();
  }
  await chmod(directory, 0o700);
  return directory;
}
async function save(directory: string, artifact: unknown) {
  const bytes = JSON.stringify(artifact, null, 2);
  const digest = hash(bytes);
  const path = join(directory, `${digest}.json`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, digest };
}

// Called only by explicit local user action; never registered as a model tool.
export async function continueGreenhouseVerification(
  config: Config,
  input: Input,
  deps: { fetch?: Fetch } = {},
) {
  let consumed = false;
  let consumptionStarted = false;
  let directory: string | undefined;
  let attempt: Record<string, unknown> | undefined;
  let initial: Scope | undefined;
  let requestBodyHash: string | undefined;
  let permitId: string | undefined;
  let receiptHash: string | undefined;
  const transport = deps.fetch ?? fetch;
  const api = async (path: string, body?: unknown) => {
    const response = await transport(`${config.api.replace(/\/$/, "")}/api/personal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 400 && response.status < 500) throw new ApiDenied();
    if (!response.ok || response.redirected) throw unavailable();
    return JSON.parse(await boundedText(response, 2_000_000)) as unknown;
  };
  try {
    const base = new URL(config.api);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !isAbsolute(config.root) ||
      !uuid.test(input.attemptId) ||
      !uuid.test(input.challengeId) ||
      !/^[a-zA-Z0-9]{8}$/.test(input.code) ||
      !config.token
    )
      throw unavailable();
    attempt = object(await api(`/attempts/${input.attemptId}`));
    const manifest = object(attempt.manifest);
    if (
      attempt.id !== input.attemptId ||
      typeof attempt.userId !== "string" ||
      !uuid.test(attempt.userId) ||
      attempt.mode !== "submit" ||
      !["submitting", "submission_uncertain"].includes(String(attempt.state)) ||
      !attempt.submitAt ||
      attempt.manifestHash !== stableHash(manifest) ||
      typeof manifest.identity !== "string"
    )
      throw unavailable();
    const identity = /^greenhouse:([a-zA-Z0-9_-]{1,100}):([1-9][0-9]*)$/.exec(manifest.identity);
    if (!identity) throw unavailable();
    const targetUrl = `https://boards.greenhouse.io/${identity[1]}/jobs/${identity[2]}`;
    initial = scope(await api(`/attempts/${input.attemptId}/challenge`), input);
    if (
      initial.transport.targetUrl !== targetUrl ||
      initial.transport.manifestHash !== attempt.manifestHash ||
      initial.challenge.status !== "awaiting_user" ||
      !initial.challenge.hasRecipient ||
      ![
        "captcha-failed",
        "invalid-security-code",
        "expired-security-code",
        "security-code-error",
      ].includes(initial.challenge.code)
    )
      throw unavailable();
    directory = await privateDirectory(config.root, attempt.userId);
    const originalPath = join(directory, `${initial.transport.evidenceHash}.json`);
    if (
      (await realpath(originalPath)) !== originalPath ||
      (await stat(originalPath)).size > 2_100_000
    )
      throw unavailable();
    const originalBytes = await readFile(originalPath, "utf8");
    if (hash(originalBytes) !== initial.transport.evidenceHash) throw unavailable();
    const artifact = object(JSON.parse(originalBytes));
    if (
      artifact.schemaVersion !== 1 ||
      artifact.kind !== "greenhouse_submission_payload" ||
      artifact.attemptId !== input.attemptId ||
      artifact.manifestHash !== attempt.manifestHash ||
      artifact.targetUrl !== targetUrl ||
      typeof artifact.requestBody !== "string" ||
      hash(artifact.requestBody) !== initial.transport.requestBodyHash
    )
      throw unavailable();
    const original = object(JSON.parse(artifact.requestBody));
    const application = object(original.job_application);
    if (
      !Object.keys(application).length ||
      hash(JSON.stringify(sorted(application, true))) !==
        initial.transport.applicationPayloadHash ||
      typeof original.fingerprint !== "string" ||
      !original.fingerprint ||
      Object.keys(original).some(
        (key) =>
          ![
            "job_application",
            "fingerprint",
            "g-recaptcha-enterprise-token",
            "security_code",
            "captcha_retried",
          ].includes(key),
      )
    )
      throw unavailable();
    const leaseOwner = config.leaseOwner ?? `email-verification-${randomUUID()}`;
    if (!leaseOwner || leaseOwner.length > 200) throw unavailable();
    const leased = scope(
      await api(`/attempts/${input.attemptId}/challenge/lease`, {
        challengeId: input.challengeId,
        leaseOwner,
        explicitUser: true,
      }),
      input,
    );
    const lease = fence(leased, initial, leaseOwner, "leased");
    const requestBody = JSON.stringify({
      job_application: application,
      fingerprint: original.fingerprint,
      security_code: input.code,
    });
    requestBodyHash = hash(requestBody);
    const continuation = await save(directory, {
      schemaVersion: 1,
      kind: "greenhouse_submission_payload",
      attemptId: input.attemptId,
      manifestHash: attempt.manifestHash,
      targetUrl,
      requestBody,
      capturedAt: new Date().toISOString(),
    });
    const permitted = scope(
      await api(`/attempts/${input.attemptId}/challenge/continue`, {
        ...lease,
        explicitUser: true,
        evidenceHash: continuation.digest,
      }),
      input,
    );
    if (
      fence(permitted, initial, leaseOwner, "permitted").leaseGeneration !== lease.leaseGeneration
    )
      throw unavailable();
    const permit = permitted.challenge.permit;
    if (
      !permit ||
      !uuid.test(permit.permitId) ||
      permit.status !== "issued" ||
      permit.evidenceHash !== continuation.digest ||
      permit.requestBodyHash !== requestBodyHash ||
      !Number.isFinite(Date.parse(permit.expiresAt)) ||
      Date.parse(permit.expiresAt) <= Date.now()
    )
      throw unavailable();
    permitId = permit.permitId;
    consumptionStarted = true;
    const consumedScope = scope(
      await api(`/attempts/${input.attemptId}/challenge/consume`, { ...lease, permitId }),
      input,
    );
    if (
      fence(consumedScope, initial, leaseOwner, "continuing").leaseGeneration !==
        lease.leaseGeneration ||
      consumedScope.challenge.permit?.permitId !== permitId ||
      consumedScope.challenge.permit.status !== "consumed" ||
      consumedScope.challenge.permit.requestBodyHash !== requestBodyHash
    )
      throw unavailable();
    consumed = true;
    const response = await transport(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://job-boards.greenhouse.io",
        referer: `https://job-boards.greenhouse.io/${identity[1]}/jobs/${identity[2]}`,
      },
      body: requestBody,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.redirected || response.url !== targetUrl) throw unavailable();
    const responseBody = await boundedText(response, 100_000);
    const capturedAt = new Date().toISOString();
    const result = classifyGreenhouseResponse(response.status, responseBody);
    const receipt = await save(directory, {
      schemaVersion: 1,
      kind:
        result.kind === "challenge"
          ? "greenhouse_post_submit_challenge"
          : "greenhouse_verification_response",
      attemptId: input.attemptId,
      challengeId: input.challengeId,
      permitId,
      manifestHash: attempt.manifestHash,
      targetUrl,
      requestBodyHash,
      applicationPayloadHash: initial.transport.applicationPayloadHash,
      responseStatus: response.status,
      responseBody,
      capturedAt,
    });
    receiptHash = receipt.digest;
    if (result.kind === "challenge") {
      await api(`/attempts/${input.attemptId}/challenge`, { evidenceHash: receipt.digest });
      return {
        status: "submission_uncertain" as const,
        receiptHash,
        needsUser: "Verification remains required on this same attempt.",
      };
    }
    let validAcceptedBody = !responseBody.trim();
    if (
      responseBody.trim() &&
      /^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    ) {
      try {
        object(JSON.parse(responseBody));
        validAcceptedBody = true;
      } catch {
        validAcceptedBody = false;
      }
    }
    const submitted = result.kind === "accepted" && validAcceptedBody;
    const reconciled = object(
      await api(`/attempts/${input.attemptId}/reconcile`, {
        evidence: {
          outcome: submitted ? "submitted" : "uncertain",
          kind: submitted ? "ats_status" : "manual_review",
          artifactPath: receipt.path,
          sha256: receipt.digest,
          sourceUrl: targetUrl,
          capturedAt,
          details: submitted
            ? "Employer acceptance response matched the consumed verification permit and frozen application."
            : "Employer response did not prove acceptance; do not retry.",
          manifestHash: attempt.manifestHash,
        },
      }),
    );
    if (
      reconciled.id !== input.attemptId ||
      reconciled.state !== (submitted ? "submitted" : "submission_uncertain")
    )
      throw unavailable();
    return {
      status: submitted ? ("submitted" as const) : ("submission_uncertain" as const),
      receiptHash,
    };
  } catch (error) {
    if (!consumed && (!consumptionStarted || error instanceof ApiDenied)) throw unavailable();
    if (!receiptHash && directory && attempt && initial) {
      try {
        receiptHash = (
          await save(directory, {
            schemaVersion: 1,
            kind: "greenhouse_verification_uncertain",
            attemptId: input.attemptId,
            challengeId: input.challengeId,
            permitId,
            manifestHash: attempt.manifestHash,
            targetUrl: initial.transport.targetUrl,
            requestBodyHash,
            applicationPayloadHash: initial.transport.applicationPayloadHash,
            capturedAt: new Date().toISOString(),
            details:
              "Verification response or receipt unavailable after one-use permit consumption; do not retry.",
          })
        ).digest;
      } catch {
        /* The consumed permit remains authoritative when local receipt storage fails. */
      }
    }
    return {
      status: "submission_uncertain" as const,
      ...(receiptHash ? { receiptHash } : {}),
      needsUser: "Verification outcome is uncertain; reconcile this same attempt without retrying.",
    };
  }
}
