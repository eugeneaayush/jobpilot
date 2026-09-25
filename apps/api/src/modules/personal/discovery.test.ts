import { descriptionText, discoverGreenhouse } from "./discovery";
import { describe, expect, test } from "bun:test";

const job = {
  id: 123,
  internal_job_id: 456,
  requisition_id: "REQ-9",
  title: "Analyst",
  absolute_url: "https://example.com/jobs/123",
  content: "&lt;p&gt;Requirements&lt;/p&gt;",
  location: { name: "Remote" },
  custom: { preserve: true },
};
const fixture = (body: unknown, status = 200, headers = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
describe("Greenhouse public discovery", () => {
  test("preserves identifiers, all native fields and full content", async () => {
    const result = await discoverGreenhouse("example", {
      fetch: fixture({ jobs: [job], meta: { total: 1 } }),
      employer: "Example",
    });
    expect(result.status).toBe("complete");
    expect(result.postings[0]?.nativeId).toBe("123");
    expect(result.postings[0]?.internalJobId).toBe("456");
    expect(result.postings[0]?.requisitionId).toBe("REQ-9");
    expect(result.postings[0]?.raw.custom).toEqual({ preserve: true });
    expect(result.postings[0]?.descriptionText).toBe("Requirements");
  });
  test("keeps multiple posts for one employer job distinct and handles prospect posts", async () => {
    const result = await discoverGreenhouse("example", {
      fetch: fixture({
        jobs: [
          job,
          { ...job, id: 124 },
          { ...job, id: 125, internal_job_id: null, requisition_id: null },
        ],
        meta: { total: 3 },
      }),
    });
    expect(result.status).toBe("complete");
    expect(
      result.postings.map((post) => [post.nativeId, post.internalJobId, post.requisitionId]),
    ).toEqual([
      ["123", "456", "REQ-9"],
      ["124", "456", "REQ-9"],
      ["125", null, null],
    ]);
  });
  test("rejects arbitrary hosts and URL segments", async () => {
    await expect(discoverGreenhouse("https://localhost")).rejects.toThrow("Invalid");
    await expect(discoverGreenhouse("../admin")).rejects.toThrow("Invalid");
  });
  test("validates missing pages, totals and duplicate IDs", async () => {
    expect(
      (await discoverGreenhouse("example", { fetch: fixture({ jobs: [job], meta: { total: 2 } }) }))
        .status,
    ).toBe("partial");
    expect(
      (
        await discoverGreenhouse("example", {
          fetch: fixture({ jobs: [job, job], meta: { total: 2 } }),
        })
      ).status,
    ).toBe("partial");
    expect((await discoverGreenhouse("example", { fetch: fixture({ jobs: [] }) })).status).toBe(
      "partial",
    );
  });
  test("auth, rate limit and malformed payload are not empty success", async () => {
    expect((await discoverGreenhouse("example", { fetch: fixture({}, 403) })).status).toBe(
      "blocked",
    );
    const waits: number[] = [];
    const rate = await discoverGreenhouse("example", {
      fetch: fixture({}, 429, { "Retry-After": "2" }),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(rate.health.attempts).toBe(3);
    expect(rate.status).toBe("blocked");
    expect(waits).toEqual([2000, 2000]);
    expect(
      (await discoverGreenhouse("example", { fetch: fixture({ error: "bad" }), retries: 0 }))
        .status,
    ).toBe("failed");
  });
  test("does not violate long Retry-After", async () => {
    const result = await discoverGreenhouse("example", {
      fetch: fixture({}, 429, { "Retry-After": "120" }),
    });
    expect(result.health.attempts).toBe(1);
    expect(result.status).toBe("blocked");
  });
  test("encoded active markup becomes inert text", () => {
    expect(
      descriptionText(
        "&amp;lt;script&amp;gt;steal()&amp;lt;/script&amp;gt;&lt;p&gt;Safe &amp; sound&lt;/p&gt;",
      ),
    ).toBe("Safe & sound");
  });
});
