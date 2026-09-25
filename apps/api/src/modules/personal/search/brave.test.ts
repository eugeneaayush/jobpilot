import { braveRequestUrl, fetchBravePage, searchHash } from "./brave";
import { searchFixture, searchNow, syntheticPage, syntheticQuery, syntheticResult } from "./fakes";
import { describe, expect, test } from "bun:test";

describe("Brave restricted transport", () => {
  test("query text cannot change endpoint, headers, or activate other APIs", async () => {
    const query = "careers &endpoint=https://127.0.0.1/private # jobs";
    const f = searchFixture([syntheticPage([], false, query)]);
    const result = await fetchBravePage(query, 0, 20, { apiKey: "fixture", fetch: f.deps.fetch });
    expect(result.status).toBe("completed");
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe(query);
    expect(url.searchParams.has("endpoint")).toBe(false);
    expect(f.calls[0]?.init?.redirect).toBe("error");
  });
  test("invalid/missing pagination and altered query cannot establish exhausted coverage", async () => {
    for (const payload of [
      { ...syntheticPage(), query: { original: syntheticQuery } },
      { ...syntheticPage(), query: { original: "another query", more_results_available: false } },
      {
        ...syntheticPage(),
        query: {
          original: syntheticQuery,
          more_results_available: false,
          altered: "another query",
        },
      },
      {},
    ]) {
      const f = searchFixture([payload]);
      const result = await fetchBravePage(syntheticQuery, 0, 20, {
        apiKey: "fixture",
        fetch: f.deps.fetch,
      });
      expect(result.status).toBe("failed");
      expect(result.candidates).toHaveLength(0);
    }
  });
  test("rejects unsafe URLs without following them or claiming employer identity", async () => {
    const f = searchFixture([
      syntheticPage([
        syntheticResult("http://example.com"),
        syntheticResult("https://127.0.0.1/admin"),
        syntheticResult("https://[::1]/"),
        syntheticResult("https://private.local/"),
        syntheticResult("https://user:pass@example.com/"),
        syntheticResult("javascript:alert(1)"),
        syntheticResult("https://careers.example.com/jobs#apply"),
      ]),
    ]);
    const result = await fetchBravePage(syntheticQuery, 0, 20, {
      apiKey: "fixture",
      fetch: f.deps.fetch,
    });
    expect(result.status).toBe("completed");
    expect(result.invalidCount).toBe(6);
    expect(result.reason).toBe("invalid_candidate_rows");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.url).toBe("https://careers.example.com/jobs");
    expect(f.calls).toHaveLength(1);
  });
  test("hashes exact response bytes and does not mistake too-few results for exhaustion", async () => {
    const bytes = `${JSON.stringify(syntheticPage([syntheticResult()], true))}\n`;
    const f = searchFixture([new Response(bytes)]);
    const result = await fetchBravePage(syntheticQuery, 0, 20, {
      apiKey: "fixture",
      fetch: f.deps.fetch,
    });
    expect(result.responseHash).toBe(searchHash(bytes));
    expect(result.moreResultsAvailable).toBe(true);
    expect(result.observedCount).toBe(1);
  });
  test("HTTP failures, malformed/oversized bodies and redirects never retry internally", async () => {
    const redirect = new Response("{}");
    Object.defineProperty(redirect, "redirected", { value: true });
    for (const response of [
      new Response(null, { status: 503 }),
      new Response("{"),
      new Response("{}", { headers: { "content-length": "2000001" } }),
      redirect,
    ]) {
      const f = searchFixture([response]);
      const result = await fetchBravePage(syntheticQuery, 0, 20, {
        apiKey: "fixture",
        fetch: f.deps.fetch,
      });
      expect(result.status).not.toBe("completed");
      expect(result.candidates).toHaveLength(0);
      expect(f.calls).toHaveLength(1);
    }
  });
  test("server cooldown dates and absent rate-limit headers have bounded future eligibility", async () => {
    for (const [status, headers, expected] of [
      [503, { "retry-after": "Wed, 16 Sep 2026 13:00:00 GMT" }, "2026-09-16T13:00:00.000Z"],
      [429, {}, "2026-09-16T12:01:00.000Z"],
    ] as const) {
      const f = searchFixture([new Response(null, { status, headers })]);
      const result = await fetchBravePage(syntheticQuery, 0, 20, {
        apiKey: "fixture",
        fetch: f.deps.fetch,
        now: searchNow,
      });
      expect(result.nextEligibleAt?.toISOString()).toBe(expected);
    }
    expect(() => braveRequestUrl(syntheticQuery, 10, 20)).toThrow("bounds");
    expect(() => braveRequestUrl(syntheticQuery, 0, 21)).toThrow("bounds");
  });
});
