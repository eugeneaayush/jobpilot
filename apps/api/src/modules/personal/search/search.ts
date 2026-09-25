import {
  type PersonalSearchInput,
  type PersonalSearchReceipt,
  type PersonalSearchResponse,
  personalSearchSchema,
} from "@jobpilot/contracts/personal-search";
import { BRAVE_REQUEST_MICROUSD, braveRequestUrl, fetchBravePage, searchHash } from "./brave";
import type { SpendRequest, SpendReservation } from "./budget";

export interface SearchDependencies {
  configuration: (userId: string) => Promise<Record<string, unknown>>;
  reserve: (userId: string, request: SpendRequest, now: Date) => Promise<SpendReservation>;
  finish: (
    userId: string,
    receipt: PersonalSearchReceipt,
    metadata: Record<string, unknown>,
    now: Date,
  ) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export async function runPersonalSearch(
  userId: string,
  input: PersonalSearchInput,
  deps: SearchDependencies,
): Promise<PersonalSearchResponse> {
  const parsed = personalSearchSchema.parse(input);
  const now = deps.now ?? (() => new Date());
  const result: PersonalSearchResponse = {
    provider: "brave",
    status: "missing_setup",
    queryHash: searchHash(parsed.query),
    candidates: [],
    coverage: {
      scope: "search_query",
      exhausted: false,
      empty: null,
      pagesRequested: 0,
      observedCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      moreResultsAvailable: null,
    },
    receipts: [],
    budget: null,
    nextEligibleAt: null,
    reasons: [],
    price: {
      requestMicrousd: BRAVE_REQUEST_MICROUSD,
      verifiedOn: "2026-09-16",
      sourceUrl: "https://brave.com/search/api/",
      creditsAssumed: false,
    },
  };
  const config = await deps.configuration(userId);
  const provider = config.searchProvider;
  const key =
    provider &&
    typeof provider === "object" &&
    "provider" in provider &&
    provider.provider === "brave" &&
    "apiKey" in provider
      ? provider.apiKey
      : undefined;
  if (typeof key !== "string" || !key || key.length > 1024 || /[\s\p{Cc}]/u.test(key)) {
    result.reasons.push("brave_api_key_missing_or_invalid");
    return result;
  }
  const seen = new Set<string>();
  for (let page = 0; page < parsed.maxPages; page++) {
    if (deps.signal?.aborted) {
      result.status = result.receipts.length ? "partial" : "failed";
      result.reasons.push("search_cancelled_before_reservation");
      break;
    }
    const sourceUrlHash = searchHash(braveRequestUrl(parsed.query, page, parsed.pageSize).href);
    const reservation = await deps.reserve(
      userId,
      {
        provider: "brave",
        category: "search",
        amountMicrousd: BRAVE_REQUEST_MICROUSD,
        requestHash: sourceUrlHash,
      },
      now(),
    );
    result.budget = reservation.budget;
    if (!reservation.ok) {
      result.status = result.receipts.length ? "partial" : reservation.reason;
      result.nextEligibleAt = reservation.nextEligibleAt;
      result.reasons.push(reservation.reason);
      break;
    }
    // No network call can occur until the durable reservation transaction has committed.
    const response = await fetchBravePage(parsed.query, page, parsed.pageSize, {
      apiKey: key,
      fetch: deps.fetch,
      now,
      timeoutMs: deps.timeoutMs,
      signal: deps.signal,
    });
    const receipt: PersonalSearchReceipt = {
      reservationId: reservation.id,
      status: response.status,
      amountMicrousd: BRAVE_REQUEST_MICROUSD,
      page,
      sourceUrlHash,
      responseHash: response.responseHash,
      httpStatus: response.httpStatus,
      observedCount: response.observedCount,
      nextEligibleAt: response.nextEligibleAt,
      reason: response.reason,
    };
    await deps.finish(
      userId,
      receipt,
      {
        queryHash: result.queryHash,
        endpoint: "https://api.search.brave.com/res/v1/web/search",
        candidates: response.candidates,
        invalidCount: response.invalidCount,
        moreResultsAvailable: response.moreResultsAvailable,
        price: result.price,
      },
      now(),
    );
    result.receipts.push(receipt);
    result.coverage.pagesRequested++;
    result.coverage.observedCount += response.observedCount;
    result.coverage.invalidCount += response.invalidCount;
    result.coverage.moreResultsAvailable = response.moreResultsAvailable;
    result.nextEligibleAt = response.nextEligibleAt;
    if (response.reason) result.reasons.push(response.reason);
    for (const candidate of response.candidates) {
      if (seen.has(candidate.url)) {
        result.coverage.duplicateCount++;
        continue;
      }
      seen.add(candidate.url);
      result.candidates.push(candidate);
    }
    if (response.status !== "completed") {
      result.status = page > 0 ? "partial" : "failed";
      if (page === 0 && response.status === "blocked") result.status = "blocked";
      break;
    }
    if (response.moreResultsAvailable === false) {
      result.coverage.exhausted = true;
      result.status = result.reasons.length ? "partial" : "complete";
      result.coverage.empty = result.status === "complete" ? result.candidates.length === 0 : null;
      break;
    }
    result.status = "partial";
    if (response.reason === "inconsistent_pagination") break;
    if (page === parsed.maxPages - 1) result.reasons.push("search_page_cap_reached");
  }
  return result;
}
