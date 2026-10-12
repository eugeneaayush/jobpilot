import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type PersonalApprovalEvent,
  type PersonalApprovalReceipt,
  personalApprovalEventSchema,
  personalApprovalReceiptSchema,
} from "@jobpilot/contracts/personal-approval";
import { z } from "zod";
import { conflict, forbidden } from "@/common/errors";
import { manifestHash, policyDay } from "./persistence-policy";

export function approvalHistory(details: Record<string, unknown>): PersonalApprovalEvent[] {
  const parsed = z.array(personalApprovalEventSchema).safeParse(details.applicationApprovals ?? []);
  if (!parsed.success) throw conflict("Application approval history is invalid");
  return parsed.data;
}

export function approvalExpiry(timezone: string, now = new Date()) {
  const day = policyDay(timezone, now);
  let low = now.getTime();
  let high = low + 26 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (policyDay(timezone, new Date(middle)) === day) low = middle;
    else high = middle;
  }
  return new Date(Math.min(high, now.getTime() + 24 * 60 * 60 * 1000));
}

export function activeApproval(
  events: PersonalApprovalEvent[],
  packetHash: string,
  campaignId: string,
  campaignRunId: string,
  attemptId?: string,
  now = new Date(),
): PersonalApprovalReceipt {
  const match = [...events].reverse().find((event) => event.kind === "approved");
  if (match?.kind !== "approved")
    throw conflict("Review and approve this application before live transmission");
  const receipt = match.receipt;
  if (
    receipt.packetHash !== packetHash ||
    receipt.campaignId !== campaignId ||
    receipt.campaignRunId !== campaignRunId
  )
    throw conflict("Application approval is stale; review the current packet");
  if (Date.parse(receipt.expiresAt) <= now.getTime())
    throw conflict("Application approval expired");
  if (events.some((event) => event.kind === "withdrawn" && event.approvalId === receipt.id))
    throw conflict("Application approval was withdrawn");
  const binding = events.find((event) => event.kind === "bound" && event.approvalId === receipt.id);
  if (binding && (binding.kind !== "bound" || binding.attemptId !== attemptId))
    throw conflict("Application approval is already bound to another attempt");
  if (attemptId && !binding) throw conflict("Attempt has no bound application approval");
  return receipt;
}

export function requireApprovalReceipt(value: unknown, current: PersonalApprovalReceipt) {
  const parsed = personalApprovalReceiptSchema.safeParse(value);
  if (!parsed.success || manifestHash(parsed.data) !== manifestHash(current))
    throw conflict("Attempt approval receipt does not match the approved packet");
}

export function requireDashboardOrigin(
  headers: Record<string, string | undefined>,
  allowedOrigins: string,
  method = "POST",
) {
  if (headers.authorization)
    throw forbidden(
      "Application approval requires a dashboard cookie session; bearer authorization is not accepted",
    );
  let origin = headers.origin;
  if (!origin && method === "GET" && headers.referer) {
    try {
      origin = new URL(headers.referer).origin;
    } catch {
      throw forbidden("Invalid dashboard referer");
    }
  }
  if (
    !origin ||
    !allowedOrigins
      .split(",")
      .map((item) => item.trim())
      .includes(origin)
  )
    throw forbidden("Application approval requires the configured dashboard origin");
  if (headers["sec-fetch-site"] === "cross-site")
    throw forbidden("Cross-site application approval is not accepted");
}

export function approvalNonce(
  secret: string,
  session: string,
  userId: string,
  recordId: string,
  recordVersion: string,
  packetHash: string,
  expires = Date.now() + 10 * 60_000,
) {
  const content = {
    userId,
    recordId,
    recordVersion,
    packetHash,
    expires,
    sessionHash: manifestHash(session),
  };
  const payload = Buffer.from(JSON.stringify(content)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyApprovalNonce(
  secret: string,
  session: string,
  userId: string,
  recordId: string,
  recordVersion: string,
  packetHash: string,
  nonce: string,
) {
  const [payload, signature, extra] = nonce.split(".");
  if (!payload || !signature || extra) throw forbidden("Invalid application confirmation nonce");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    throw forbidden("Invalid application confirmation nonce");
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    throw forbidden("Invalid application confirmation nonce");
  }
  if (
    content.userId !== userId ||
    content.recordId !== recordId ||
    content.recordVersion !== recordVersion ||
    content.packetHash !== packetHash ||
    content.sessionHash !== manifestHash(session) ||
    typeof content.expires !== "number" ||
    content.expires <= Date.now()
  )
    throw forbidden("Application confirmation expired or belongs to another session or packet");
}
