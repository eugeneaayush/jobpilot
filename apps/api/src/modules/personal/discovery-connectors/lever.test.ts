import { jsonFetch, leverJob, now } from "./fakes";
import { discoverLever } from "./lever";
import { describe, expect, test } from "bun:test";

describe("Lever public discovery", () => {
  test("paginates global listings and retains every description section and page provenance", async () => {
    const fake = jsonFetch([[leverJob("a"), leverJob("b")], [leverJob("c")]]);
    const result = await discoverLever("example", {
      ...fake,
      now,
      pageSize: 2,
      employer: "Example Corp",
    });
    expect(result.status).toBe("complete");
    expect(result.postings.map((job) => job.nativeId)).toEqual(["a", "b", "c"]);
    expect(result.expectedTotal).toBeNull();
    expect(result.coverage).toEqual({
      scope: "public_board",
      observedTotal: 3,
      excludedUnlisted: 0,
      exhausted: true,
      empty: false,
    });
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://api.lever.co/v0/postings/example?mode=json&skip=0&limit=2",
      "https://api.lever.co/v0/postings/example?mode=json&skip=2&limit=2",
    ]);
    expect(
      fake.calls.every(({ init }) => init?.method === "GET" && init.redirect === "error"),
    ).toBe(true);
    const job = result.postings[0];
    expect(job?.descriptionText).toContain("MBA enrollment required.");
    expect(job?.descriptionText).toContain("Apply by the deadline");
    expect(job?.descriptionText).toContain("Compensation disclosed");
    expect(job?.locations).toEqual(["New York", "Boston"]);
    expect(job?.employer).toBe("Example Corp");
    expect(job?.employerNameSource).toBe("configured");
    expect(job?.requisitionId).toBeNull();
    expect(job?.publishedAt).toBeNull();
    expect(job?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.postings[2]?.provenance.responseHash).toBe(
      result.health.receipts[1]?.contentHash ?? "",
    );
    expect(result.postings[2]?.provenance.row).toBe(3);
  });
  test("uses only EU endpoints and verifies a final empty page after a full page", async () => {
    const fake = jsonFetch([[leverJob("a", "eu")], []]);
    const result = await discoverLever("example", { ...fake, region: "eu", pageSize: 1 });
    expect(result.status).toBe("complete");
    expect(result.postings[0]?.sourceRegion).toBe("eu");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every(({ url }) => new URL(url).host === "api.eu.lever.co")).toBe(true);
  });
  test("a successful empty board differs from denied, malformed, and capped responses", async () => {
    expect((await discoverLever("example", jsonFetch([[]]))).coverage.empty).toBe(true);
    const denied = await discoverLever("example", jsonFetch([new Response(null, { status: 403 })]));
    expect(denied.status).toBe("blocked");
    expect(denied.coverage.empty).toBeNull();
    expect((await discoverLever("example", jsonFetch([{ jobs: [] }]))).status).toBe("failed");
    const capped = await discoverLever("example", {
      ...jsonFetch([[leverJob()]]),
      pageSize: 1,
      maxPages: 1,
    });
    expect(capped.status).toBe("partial");
    expect(capped.coverage.exhausted).toBe(false);
  });
  test("preserves earlier pages after rate limiting and exposes future eligibility", async () => {
    const fake = jsonFetch([
      [leverJob()],
      new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    ]);
    const result = await discoverLever("example", { ...fake, pageSize: 1, now });
    expect(result.status).toBe("partial");
    expect(result.postings).toHaveLength(1);
    expect(result.health.lastFailure).toBe("blocked");
    expect(result.health.nextEligibleAt).toBe("2026-09-16T12:02:00.000Z");
    expect(fake.calls).toHaveLength(2);
  });
  test("rejects repeated pagination, conflicting identities and missing description sections", async () => {
    const repeat = await discoverLever("example", {
      ...jsonFetch([[leverJob()], [leverJob()]]),
      pageSize: 1,
    });
    expect(repeat.status).toBe("partial");
    expect(repeat.postings).toHaveLength(1);
    expect(repeat.health.errors.join()).toContain("pagination repeated");
    const result = await discoverLever(
      "example",
      jsonFetch([
        [
          leverJob(),
          leverJob(),
          { ...leverJob("foreign"), hostedUrl: "https://jobs.lever.co/other/foreign" },
          { ...leverJob("truncated"), lists: undefined },
        ],
      ]),
    );
    expect(result.status).toBe("partial");
    expect(result.postings).toHaveLength(1);
    expect(result.health.errors).toHaveLength(3);
  });
  test("rejects invalid board and pagination configuration before network access", async () => {
    const fake = jsonFetch([]);
    await expect(discoverLever("../example", fake)).rejects.toThrow("board token");
    await expect(discoverLever("example", { ...fake, maxPages: 101 })).rejects.toThrow("bound");
    expect(fake.calls).toHaveLength(0);
  });
});
