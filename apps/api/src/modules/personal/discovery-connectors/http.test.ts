import { discoverAshby } from "./ashby";
import { sha256 } from "./common";
import { jsonFetch, now } from "./fakes";
import { describe, expect, test } from "bun:test";

describe("bounded public connector transport", () => {
  test("retries transient server failure twice with bounded waits and per-request receipts", async () => {
    const fake = jsonFetch([
      new Response(null, { status: 503 }),
      new Response(null, { status: 502 }),
      { apiVersion: "1", jobs: [] },
    ]);
    const waits: number[] = [];
    const result = await discoverAshby("example", {
      ...fake,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.status).toBe("complete");
    expect(result.health.attempts).toBe(3);
    expect(result.health.receipts.map(({ httpStatus }) => httpStatus)).toEqual([503, 502, 200]);
    expect(waits).toEqual([250, 500]);
  });
  test("rate limits never become empty boards or trigger immediate retries", async () => {
    for (const [header, expected] of [
      ["90", "2026-09-16T12:01:30.000Z"],
      ["Wed, 16 Sep 2026 12:02:00 GMT", "2026-09-16T12:02:00.000Z"],
      ["invalid", "2026-09-16T12:01:00.000Z"],
    ]) {
      const fake = jsonFetch([
        new Response(null, { status: 429, headers: { "retry-after": header } }),
      ]);
      const result = await discoverAshby("example", { ...fake, now });
      expect(result.status).toBe("blocked");
      expect(result.coverage.empty).toBeNull();
      expect(result.health.nextEligibleAt).toBe(expected);
      expect(fake.calls).toHaveLength(1);
    }
  });
  test("a server Retry-After defers work rather than sleeping beyond this discovery run", async () => {
    const fake = jsonFetch([
      new Response(null, { status: 503, headers: { "retry-after": "3600" } }),
    ]);
    const result = await discoverAshby("example", { ...fake, now });
    expect(result.status).toBe("failed");
    expect(result.health.nextEligibleAt).toBe("2026-09-16T13:00:00.000Z");
    expect(fake.calls).toHaveLength(1);
  });
  test("denial and client errors are not retried", async () => {
    for (const status of [401, 403, 404]) {
      const fake = jsonFetch([new Response(null, { status })]);
      const result = await discoverAshby("example", fake);
      expect(result.status).toBe(status === 404 ? "failed" : "blocked");
      expect(result.coverage.empty).toBeNull();
      expect(fake.calls).toHaveLength(1);
    }
  });
  test("bounded retries terminate network errors with unknown coverage", async () => {
    let calls = 0;
    const result = await discoverAshby("example", {
      fetch: (async () => {
        calls++;
        throw new Error("synthetic network failure");
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.health.receipts).toHaveLength(3);
    expect(result.coverage.exhausted).toBe(false);
  });
  test("rejects oversized headers, streamed bodies and malformed JSON", async () => {
    for (const response of [
      new Response("[]", { headers: { "content-length": "100" } }),
      new Response("long streamed response"),
      new Response("{"),
    ]) {
      const result = await discoverAshby("example", {
        ...jsonFetch([response]),
        maxResponseBytes: 10,
        retries: 0,
      });
      expect(result.status).toBe("failed");
      expect(result.coverage.empty).toBeNull();
      expect(result.health.errors).toHaveLength(1);
    }
  });
  test("caller cancellation avoids any request and stalled streams obey the deadline", async () => {
    const fake = jsonFetch([]);
    const cancelled = await discoverAshby("example", { ...fake, signal: AbortSignal.abort() });
    expect(cancelled.status).toBe("failed");
    expect(cancelled.health.attempts).toBe(0);
    expect(fake.calls).toHaveLength(0);
    let cancelledStream = false;
    const stream = new ReadableStream({
      cancel() {
        cancelledStream = true;
      },
    });
    const stalled = await discoverAshby("example", {
      ...jsonFetch([new Response(stream)]),
      timeoutMs: 20,
      retries: 0,
    });
    expect(stalled.status).toBe("failed");
    expect(cancelledStream).toBe(true);
    expect(stalled.health.errors[0]).toContain("aborted");
  });
  test("injected redirects are rejected and invalid bounds do not fetch", async () => {
    const redirected = new Response("{}");
    Object.defineProperty(redirected, "redirected", { value: true });
    const result = await discoverAshby("example", { ...jsonFetch([redirected]), retries: 0 });
    expect(result.status).toBe("failed");
    expect(result.health.errors[0]).toContain("redirect");
    const fake = jsonFetch([]);
    await expect(discoverAshby("example", { ...fake, retries: 3 })).rejects.toThrow("retry bound");
    await expect(discoverAshby("example", { ...fake, timeoutMs: 30_001 })).rejects.toThrow("bound");
    expect(fake.calls).toHaveLength(0);
  });
  test("receipts hash the exact source bytes, including whitespace", async () => {
    const body = '  { "apiVersion": "1", "jobs": [] }\n';
    const result = await discoverAshby("example", jsonFetch([new Response(body)]));
    expect(result.status).toBe("complete");
    expect(result.health.receipts[0]?.contentHash).toBe(sha256(Buffer.from(body)));
    expect(result.health.receipts[0]?.bytes).toBe(Buffer.byteLength(body));
  });
});
