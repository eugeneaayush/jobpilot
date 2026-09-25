import { createHash } from "node:crypto";
import type { ConnectorOptions, ConnectorPosting, ConnectorResult } from "./types";

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const textValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a posting object");
  return value as Record<string, unknown>;
}
export function boardToken(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid board token");
  return value;
}
export function requiredText(value: unknown, name: string) {
  const text = textValue(value);
  if (!text) throw new Error(`Missing ${name}`);
  return text;
}
export function sourceDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Invalid source date; use ISO dates with an explicit timezone for times");
  if (new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10))
    throw new Error("Invalid calendar date");
  return value;
}
export function postingUrl(value: unknown, host?: string, board?: string) {
  const parsed = new URL(requiredText(value, "posting URL"));
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (host && parsed.host !== host)
  )
    throw new Error("Untrusted posting URL");
  if (board && parsed.pathname.split("/").filter(Boolean)[0] !== board)
    throw new Error("Posting URL differs from board identity");
  return parsed;
}
export function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error("Invalid discovery bound");
  return value;
}
export function createResult(
  sourceUrl: string,
  options: Pick<ConnectorOptions, "now">,
  scope: ConnectorResult["coverage"]["scope"] = "public_board",
): ConnectorResult {
  return {
    status: "failed",
    postings: [],
    sourceUrl,
    contentHash: null,
    expectedTotal: null,
    health: {
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      attempts: 0,
      httpStatus: null,
      errors: [],
      nextEligibleAt: null,
      lastFailure: null,
      receipts: [],
    },
    coverage: { scope, observedTotal: 0, excludedUnlisted: 0, exhausted: false, empty: null },
  };
}
export function finishResult(result: ConnectorResult) {
  if (result.coverage.exhausted)
    result.status = result.health.errors.length ? "partial" : "complete";
  else if (result.postings.length) result.status = "partial";
  else
    result.status =
      result.health.lastFailure ?? (result.coverage.observedTotal ? "partial" : "failed");
  result.coverage.empty = result.status === "complete" ? result.postings.length === 0 : null;
  if (!result.contentHash && result.health.receipts.some((receipt) => receipt.contentHash))
    result.contentHash = sha256(
      JSON.stringify(
        result.health.receipts
          .filter((receipt) => receipt.contentHash)
          .map(({ url, contentHash }) => ({ url, contentHash })),
      ),
    );
  return result;
}
export function addPosting(result: ConnectorResult, seen: Set<string>, posting: ConnectorPosting) {
  if (seen.has(posting.nativeId)) throw new Error(`Duplicate posting ID ${posting.nativeId}`);
  seen.add(posting.nativeId);
  result.postings.push(posting);
}
export function rowError(result: ConnectorResult, row: number, error: unknown) {
  result.health.errors.push(
    `Row ${row}: ${error instanceof Error ? error.message : "Invalid posting"}`,
  );
}
export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
