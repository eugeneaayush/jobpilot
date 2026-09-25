import { personalSearchResponseSchema } from "@jobpilot/contracts/personal-search";
import {
  searchFixture,
  searchNow,
  syntheticBudget,
  syntheticPage,
  syntheticQuery,
  syntheticResult,
} from "./fakes";
import { runPersonalSearch } from "./search";
import { describe, expect, test } from "bun:test";

describe("budgeted Brave career discovery", () => {
  test("paginates only explicit more-results and returns snippet candidates with no readiness claim", async () => {
    const f = searchFixture([
      syntheticPage([syntheticResult()], true),
      syntheticPage([syntheticResult(), syntheticResult("https://example.org/careers")]),
    ]);
    const result = await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps);
    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(2);
    expect(result.coverage).toMatchObject({
      pagesRequested: 2,
      exhausted: true,
      empty: false,
      duplicateCount: 1,
      observedCount: 3,
    });
    expect(result.candidates[0]).toMatchObject({
      evidence: "search_snippet",
      fullDescriptionAvailable: false,
      employerIdentityVerified: false,
    });
    expect(f.reservations).toHaveLength(2);
    expect(f.reservations.every((r) => r.amountMicrousd === 5000 && r.category === "search")).toBe(
      true,
    );
    expect(result.budget?.searchReservedMicrousd).toBe(10000);
    expect(f.calls.map(({ url }) => new URL(url).searchParams.get("offset"))).toEqual(["0", "1"]);
    expect(
      f.calls.every(
        ({ url, init }) =>
          new URL(url).origin === "https://api.search.brave.com" &&
          init?.method === "GET" &&
          init.redirect === "error",
      ),
    ).toBe(true);
    expect(personalSearchResponseSchema.safeParse(result).success).toBe(true);
  });
  test("missing setup never reserves or fetches", async () => {
    for (const searchProvider of [
      undefined,
      { provider: "other", apiKey: "value" },
      { provider: "brave" },
      { provider: "brave", apiKey: "bad\nkey" },
    ]) {
      const f = searchFixture([]);
      f.deps.configuration = async () => ({ searchProvider });
      const result = await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps);
      expect(result.status).toBe("missing_setup");
      expect(result.coverage.empty).toBeNull();
      expect(f.reservations).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    }
  });
  test("the request cannot start before committed budget reservation", async () => {
    const f = searchFixture([syntheticPage()]);
    const original = f.deps.reserve;
    let committed = false;
    f.deps.reserve = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      committed = true;
      return original(...args);
    };
    const fetcher = f.deps.fetch!;
    f.deps.fetch = (async (...args: Parameters<typeof fetch>) => {
      expect(committed).toBe(true);
      return fetcher(...args);
    }) as typeof fetch;
    const pending = runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps);
    expect(f.calls).toHaveLength(0);
    expect((await pending).status).toBe("complete");
  });
  test("budget/cooldown denial stops before network and later-page denial preserves partial results", async () => {
    for (const reason of ["budget_exhausted", "cooldown"] as const) {
      const f = searchFixture([]);
      f.deps.reserve = async () => ({
        ok: false,
        reason,
        nextEligibleAt: new Date("2026-10-01T04:00:00Z"),
        budget: syntheticBudget(),
      });
      expect(
        (await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps)).status,
      ).toBe(reason);
      expect(f.calls).toHaveLength(0);
    }
    const f = searchFixture([syntheticPage([syntheticResult()], true)]);
    const original = f.deps.reserve;
    f.deps.reserve = async (...args) =>
      f.calls.length
        ? {
            ok: false,
            reason: "budget_exhausted",
            nextEligibleAt: searchNow(),
            budget: syntheticBudget(),
          }
        : original(...args);
    const result = await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps);
    expect(result.status).toBe("partial");
    expect(result.candidates).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  });
  test("successful empty response, missing response fields and capped coverage are distinct", async () => {
    const empty = await runPersonalSearch(
      "synthetic-user",
      { query: syntheticQuery },
      searchFixture([syntheticPage()]).deps,
    );
    expect(empty.coverage.empty).toBe(true);
    expect(empty.status).toBe("complete");
    const missing = await runPersonalSearch(
      "synthetic-user",
      { query: syntheticQuery },
      searchFixture([
        { type: "search", query: { original: syntheticQuery, more_results_available: false } },
      ]).deps,
    );
    expect(missing.status).toBe("failed");
    expect(missing.coverage.empty).toBeNull();
    const cap = await runPersonalSearch(
      "synthetic-user",
      { query: syntheticQuery, maxPages: 1 },
      searchFixture([syntheticPage([syntheticResult()], true)]).deps,
    );
    expect(cap.status).toBe("partial");
    expect(cap.coverage.exhausted).toBe(false);
  });
  test("429 persists a charged receipt and cooldown without an automatic retry", async () => {
    const f = searchFixture([
      new Response(null, { status: 429, headers: { "retry-after": "90" } }),
    ]);
    const result = await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps);
    expect(result.status).toBe("blocked");
    expect(result.nextEligibleAt?.toISOString()).toBe("2026-09-16T12:01:30.000Z");
    expect(f.calls).toHaveLength(1);
    expect(f.saved[0]?.receipt).toMatchObject({
      status: "blocked",
      amountMicrousd: 5000,
      httpStatus: 429,
    });
    expect(result.budget?.monthlyReservedMicrousd).toBe(5000);
  });
  test("timeout stays charged/uncertain and saved metadata contains neither query nor token", async () => {
    const f = searchFixture([]);
    f.deps.timeoutMs = 20;
    f.deps.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error(`do not expose ${syntheticQuery} synthetic-key-canary`)),
          { once: true },
        );
      })) as typeof fetch;
    const result = await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps);
    expect(result.status).toBe("failed");
    expect(result.receipts[0]?.status).toBe("uncertain");
    expect(result.budget?.searchReservedMicrousd).toBe(5000);
    const stored = JSON.stringify(f.saved);
    expect(stored).not.toContain(syntheticQuery);
    expect(stored).not.toContain("synthetic-key-canary");
    expect(JSON.stringify(result)).not.toContain("synthetic-key-canary");
  });
  test("reservation/persistence failures cannot cause uncharged calls or retries", async () => {
    const denied = searchFixture([]);
    denied.deps.reserve = async () => {
      throw new Error("Synthetic database unavailable");
    };
    await expect(
      runPersonalSearch("synthetic-user", { query: syntheticQuery }, denied.deps),
    ).rejects.toThrow("database unavailable");
    expect(denied.calls).toHaveLength(0);
    const lostReceipt = searchFixture([syntheticPage([syntheticResult()], true)]);
    lostReceipt.deps.finish = async () => {
      throw new Error("Synthetic receipt unavailable");
    };
    await expect(
      runPersonalSearch("synthetic-user", { query: syntheticQuery }, lostReceipt.deps),
    ).rejects.toThrow("receipt unavailable");
    expect(lostReceipt.calls).toHaveLength(1);
    expect(lostReceipt.reservations).toHaveLength(1);
  });
  test("invalid input and pre-cancelled work do not reserve or transmit", async () => {
    const f = searchFixture([]);
    await expect(
      runPersonalSearch("synthetic-user", { query: syntheticQuery, maxPages: 11 }, f.deps),
    ).rejects.toThrow();
    await expect(
      runPersonalSearch("synthetic-user", { query: "word ".repeat(76) }, f.deps),
    ).rejects.toThrow();
    f.deps.signal = AbortSignal.abort();
    expect(
      (await runPersonalSearch("synthetic-user", { query: syntheticQuery }, f.deps)).status,
    ).toBe("failed");
    expect(f.reservations).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
});
