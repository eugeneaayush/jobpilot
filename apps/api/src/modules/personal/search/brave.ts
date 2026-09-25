import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { PersonalSearchCandidate } from "@jobpilot/contracts/personal-search";

export const BRAVE_REQUEST_MICROUSD = 5_000;
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const searchHash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
export interface BravePage {
  status: "completed" | "blocked" | "failed" | "uncertain";
  candidates: PersonalSearchCandidate[];
  sourceUrlHash: string;
  responseHash: string | null;
  httpStatus: number | null;
  observedCount: number;
  invalidCount: number;
  moreResultsAvailable: boolean | null;
  nextEligibleAt: Date | null;
  reason: string | null;
}
export function braveRequestUrl(query: string, page: number, count: number) {
  if (
    !Number.isInteger(page) ||
    page < 0 ||
    page > 9 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20 ||
    !query ||
    query.length > 600 ||
    query.split(/\s+/).length > 75 ||
    /\p{Cc}/u.test(query)
  )
    throw new Error("Invalid Brave request bounds");
  const url = new URL(BRAVE_ENDPOINT);
  url.search = new URLSearchParams({
    q: query,
    count: String(count),
    offset: String(page),
    result_filter: "web",
    spellcheck: "false",
    text_decorations: "false",
  }).toString();
  return url;
}
function publicUrl(input: unknown) {
  if (typeof input !== "string" || input.length > 8000) throw new Error("Invalid candidate URL");
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error("Nonpublic candidate URL");
  url.hash = "";
  return url.href;
}
function retryAfter(value: string | null, now: Date) {
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const timestamp = seconds === null ? Date.parse(value ?? "") : now.getTime() + seconds * 1000;
  return new Date(
    Number.isFinite(timestamp) && timestamp > now.getTime() && timestamp < 8.64e15
      ? timestamp
      : now.getTime() + 60_000,
  );
}
async function bodyBytes(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > 2_000_000) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("body_limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 2_000_000) throw new Error("body_limit");
      buffers.push(item.value);
    }
    return Buffer.concat(buffers);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}
export async function fetchBravePage(
  query: string,
  page: number,
  count: number,
  options: {
    apiKey: string;
    fetch?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<BravePage> {
  const url = braveRequestUrl(query, page, count);
  if (!options.apiKey || options.apiKey.length > 1024 || /[\s\p{Cc}]/u.test(options.apiKey))
    throw new Error("Invalid Brave configuration");
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new Error("Invalid search timeout");
  const result: BravePage = {
    status: "uncertain",
    candidates: [],
    sourceUrlHash: searchHash(url.href),
    responseHash: null,
    httpStatus: null,
    observedCount: 0,
    invalidCount: 0,
    moreResultsAvailable: null,
    nextEligibleAt: null,
    reason: null,
  };
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  try {
    const response = await (options.fetch ?? fetch)(url.href, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "application/json", "X-Subscription-Token": options.apiKey },
    });
    result.httpStatus = response.status;
    if (response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      result.reason = "redirect_rejected";
      return result;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      result.status = [401, 403, 429].includes(response.status) ? "blocked" : "failed";
      result.reason = `http_${response.status}`;
      if (response.status === 429 || response.headers.has("retry-after"))
        result.nextEligibleAt = retryAfter(
          response.headers.get("retry-after"),
          options.now?.() ?? new Date(),
        );
      return result;
    }
    const bytes = await bodyBytes(response, signal);
    result.responseHash = searchHash(bytes);
    const payload = JSON.parse(bytes.toString("utf8"));
    if (
      payload?.type !== "search" ||
      payload.query?.original !== query ||
      typeof payload.query?.more_results_available !== "boolean" ||
      !Array.isArray(payload.web?.results) ||
      payload.web.results.length > count
    ) {
      result.status = "failed";
      result.reason = "invalid_search_response";
      return result;
    }
    result.moreResultsAvailable = payload.query.more_results_available;
    result.observedCount = payload.web.results.length;
    if (payload.query.altered && payload.query.altered !== query) {
      result.status = "failed";
      result.reason = "query_changed";
      return result;
    }
    for (const raw of payload.web.results) {
      try {
        const candidateUrl = publicUrl(raw?.url);
        if (
          typeof raw.title !== "string" ||
          !raw.title.trim() ||
          raw.title.length > 4000 ||
          (raw.description != null &&
            (typeof raw.description !== "string" || raw.description.length > 20_000))
        )
          throw new Error("Invalid candidate metadata");
        result.candidates.push({
          kind: "career_url_candidate",
          url: candidateUrl,
          urlHash: searchHash(candidateUrl),
          title: raw.title,
          snippet: raw.description ?? null,
          evidence: "search_snippet",
          fullDescriptionAvailable: false,
          employerIdentityVerified: false,
          page,
          responseHash: result.responseHash,
        });
      } catch {
        result.invalidCount++;
      }
    }
    result.status = "completed";
    if (result.invalidCount) result.reason = "invalid_candidate_rows";
    if (!result.observedCount && result.moreResultsAvailable)
      result.reason = "inconsistent_pagination";
    return result;
  } catch {
    result.reason = signal.aborted ? "request_timeout_or_cancelled" : "request_or_body_failed";
    return result;
  }
}
