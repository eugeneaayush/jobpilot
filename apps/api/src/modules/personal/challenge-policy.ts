import { createHash } from "node:crypto";
import {
  personalChallengeCodes,
  personalChallengeTransportSchema,
} from "@jobpilot/contracts/personal-challenge";
import { z } from "zod";
import { conflict } from "@/common/errors";
import { manifestHash } from "./persistence-policy";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.uuid(),
  manifestHash: hash,
  targetUrl: z.url(),
  capturedAt: z.iso.datetime(),
});
export const challengePayloadArtifactSchema = base.extend({
  kind: z.literal("greenhouse_submission_payload"),
  requestBody: z.string().min(2).max(2_000_000),
});
export const challengeResponseArtifactSchema = base.extend({
  kind: z.literal("greenhouse_post_submit_challenge"),
  requestBodyHash: hash,
  applicationPayloadHash: hash,
  responseStatus: z.number().int().min(400).max(499),
  responseBody: z.string().min(2).max(100_000),
});
const requestSchema = z.strictObject({
  job_application: z.record(z.string(), z.json()),
  fingerprint: z.string().min(1).max(1000),
  "g-recaptcha-enterprise-token": z.string().min(1).max(20000).optional(),
  security_code: z.string().min(1).max(1000).optional(),
  captcha_retried: z.literal(true).optional(),
});
const responseSchema = z.object({
  code: z.enum(personalChallengeCodes),
  message: z.string().max(10000).optional(),
  security_code_recipient: z.string().min(1).max(1000).optional(),
});
function canonicalApplication(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalApplication);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalApplication(child)]),
    );
  return value;
}

export function challengeRequest(requestBody: string, identity: string, targetUrl: string) {
  const match = /^greenhouse:([a-zA-Z0-9_-]{1,100}):([1-9][0-9]*)$/.exec(identity);
  if (!match || targetUrl !== `https://boards.greenhouse.io/${match[1]}/jobs/${match[2]}`)
    throw conflict("Challenge destination must exactly match the frozen Greenhouse posting.");
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(JSON.parse(requestBody));
  } catch {
    throw conflict("Challenge request body does not match the supported Greenhouse protocol.");
  }
  if (!Object.keys(body.job_application).length)
    throw conflict("Frozen application payload must not be empty.");
  return {
    applicationPayloadHash: createHash("sha256")
      .update(JSON.stringify(canonicalApplication(body.job_application)))
      .digest("hex"),
    requestBodyHash: createHash("sha256").update(requestBody).digest("hex"),
    fingerprintHash: manifestHash(body.fingerprint),
  };
}
export function challengeResponse(responseBody: string) {
  try {
    const response = responseSchema.parse(JSON.parse(responseBody));
    return { code: response.code, hasRecipient: !!response.security_code_recipient };
  } catch {
    throw conflict("Response is not a recognized Greenhouse nonacceptance challenge.");
  }
}
const challengeSchema = z.object({
  challengeId: z.uuid(),
  code: z.enum(personalChallengeCodes),
  status: z.enum([
    "awaiting_user",
    "leased",
    "permitted",
    "continuing",
    "cancelled",
    "expired",
    "resolved",
  ]),
  hasRecipient: z.boolean(),
  leaseOwner: z.string().nullable(),
  leaseGeneration: z.number().int().nonnegative(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  evidenceHash: hash,
  permit: z
    .object({
      permitId: z.uuid(),
      status: z.enum(["issued", "consumed"]),
      expiresAt: z.iso.datetime(),
      requestBodyHash: hash,
      evidenceHash: hash,
    })
    .nullable(),
});
export const challengeLedgerSchema = z.object({
  version: z.literal(1),
  transport: personalChallengeTransportSchema.extend({
    fingerprintHash: hash,
    capturedAt: z.iso.datetime(),
  }),
  current: challengeSchema.nullable(),
  events: z.array(z.object({ at: z.iso.datetime(), kind: z.string(), data: z.json() })),
});
export type ChallengeLedger = z.infer<typeof challengeLedgerSchema>;

const acceptanceTransportSchema = z.object({
  targetUrl: z.url(),
  requestBodyHash: hash,
  applicationPayloadHash: hash,
  responseStatus: z.number().int().min(200).max(299),
  responseBody: z.string().max(100_000),
  capturedAt: z.iso.datetime(),
});
export function validateChallengeAcceptance(
  value: unknown,
  attempt: { id: string; manifestHash: string },
  artifact: unknown,
  evidence: { capturedAt: string; sourceUrl: string },
) {
  const ledger = challengeLedgerSchema.parse(value);
  const root = z
    .object({
      attemptId: z.literal(attempt.id),
      manifestHash: z.literal(attempt.manifestHash),
      capturedAt: z.literal(evidence.capturedAt),
    })
    .safeParse(artifact);
  if (!root.success) throw conflict("Employer acceptance artifact does not match this attempt.");
  const raw = artifact as Record<string, unknown>;
  const current = ledger.current;
  let transport: z.infer<typeof acceptanceTransportSchema>;
  const expectedHash = current?.permit?.requestBodyHash ?? ledger.transport.requestBodyHash;
  let earliest = ledger.transport.capturedAt;
  if (current) {
    if (
      current.status !== "continuing" ||
      current.permit?.status !== "consumed" ||
      raw.kind !== "greenhouse_verification_response" ||
      raw.challengeId !== current.challengeId ||
      raw.permitId !== current.permit.permitId ||
      evidence.sourceUrl !== ledger.transport.targetUrl
    )
      throw conflict("Employer acceptance requires the consumed same-attempt continuation permit.");
    const consumed = ledger.events.findLast((event) => event.kind === "consumed");
    if (!consumed) throw conflict("Consumed continuation evidence is unavailable.");
    earliest = consumed.at;
    const parsed = acceptanceTransportSchema.safeParse(raw);
    if (!parsed.success) throw conflict("Employer response does not prove acceptance.");
    transport = parsed.data;
  } else {
    const parsed = acceptanceTransportSchema.safeParse(raw.transport);
    if (!parsed.success) throw conflict("Employer response does not prove acceptance.");
    transport = parsed.data;
    const confirmation = new URL(ledger.transport.targetUrl);
    confirmation.pathname += "/confirmation";
    const hostedConfirmation = confirmation.href.replace(
      "https://boards.greenhouse.io/",
      "https://job-boards.greenhouse.io/",
    );
    if (
      raw.sourceUrl !== evidence.sourceUrl ||
      ![confirmation.href, hostedConfirmation].includes(evidence.sourceUrl)
    )
      throw conflict("Employer confirmation URL does not match the frozen posting.");
  }
  if (
    transport.targetUrl !== ledger.transport.targetUrl ||
    transport.requestBodyHash !== expectedHash ||
    transport.applicationPayloadHash !== ledger.transport.applicationPayloadHash ||
    Date.parse(transport.capturedAt) < Date.parse(earliest) ||
    Date.parse(transport.capturedAt) > Date.parse(evidence.capturedAt)
  )
    throw conflict("Employer response does not match the pinned application request.");
  if (transport.responseBody.trim()) {
    try {
      const body = z.record(z.string(), z.json()).parse(JSON.parse(transport.responseBody));
      if (body.code !== undefined || body.error !== undefined)
        throw new Error("Unresolved provider error");
    } catch {
      throw conflict("Employer response body does not prove acceptance.");
    }
  }
}
