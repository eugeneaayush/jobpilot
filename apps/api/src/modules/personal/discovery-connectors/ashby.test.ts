import { discoverAshby } from "./ashby";
import { ashbyJob, jsonFetch, now } from "./fakes";
import { describe, expect, test } from "bun:test";

describe("Ashby public discovery", () => {
  test("retains full evidence, locations and last-published semantics without inferring first publication", async () => {
    const fake = jsonFetch([{ apiVersion: "1", jobs: [ashbyJob()] }]);
    const result = await discoverAshby("example", { ...fake, now });
    expect(result.status).toBe("complete");
    expect(result.expectedTotal).toBeNull();
    expect(result.postings[0]).toMatchObject({
      source: "ashby",
      employer: "example",
      employerNameSource: "board_token",
      nativeId: "job-1",
      firstPublishedAt: null,
      publishedAt: "2026-09-15T12:00:00Z",
      publishedAtMeaning: "last_published",
      locations: ["New York", "Boston"],
      descriptionText: "Full MBA internship description.",
    });
    expect(result.health.receipts[0]?.contentHash).toBe(
      result.postings[0]?.provenance.responseHash ?? "",
    );
    expect(fake.calls[0]?.url).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/example?includeCompensation=true",
    );
  });
  test("excludes direct-link postings but reports the exclusion and observed total", async () => {
    const result = await discoverAshby(
      "example",
      jsonFetch([{ apiVersion: "1", jobs: [{ ...ashbyJob(), isListed: false }] }]),
    );
    expect(result.status).toBe("complete");
    expect(result.coverage).toMatchObject({ empty: true, observedTotal: 1, excludedUnlisted: 1 });
  });
  test("missing visibility, conflicting native ID, and foreign board remain partial", async () => {
    const result = await discoverAshby(
      "example",
      jsonFetch([
        {
          apiVersion: "1",
          jobs: [
            ashbyJob(),
            { ...ashbyJob("b"), isListed: undefined },
            { ...ashbyJob("c"), id: "wrong" },
            { ...ashbyJob("d"), jobUrl: "https://jobs.ashbyhq.com/other/d" },
          ],
        },
      ]),
    );
    expect(result.status).toBe("partial");
    expect(result.postings).toHaveLength(1);
    expect(result.health.errors).toHaveLength(3);
    expect(result.coverage.empty).toBeNull();
  });
  test("derives native ID only from the observed same-board URL when no ID field exists", async () => {
    const result = await discoverAshby(
      "example",
      jsonFetch([
        {
          apiVersion: "1",
          jobs: [
            { ...ashbyJob(), id: undefined, publishedAt: undefined, descriptionHtml: undefined },
          ],
        },
      ]),
    );
    expect(result.status).toBe("complete");
    expect(result.postings[0]?.nativeId).toBe("job-1");
    expect(result.postings[0]?.publishedAtMeaning).toBeNull();
    expect(result.postings[0]?.descriptionHtml).toBe("Full MBA internship description.");
  });
  test("empty, malformed schema, duplicate and impossible publication date are distinct", async () => {
    expect(
      (await discoverAshby("example", jsonFetch([{ apiVersion: "1", jobs: [] }]))).coverage.empty,
    ).toBe(true);
    expect((await discoverAshby("example", jsonFetch([{ jobs: [] }]))).status).toBe("failed");
    const bad = await discoverAshby(
      "example",
      jsonFetch([
        {
          apiVersion: "1",
          jobs: [ashbyJob(), ashbyJob(), { ...ashbyJob("b"), publishedAt: "2026-02-30T12:00:00Z" }],
        },
      ]),
    );
    expect(bad.status).toBe("partial");
    expect(bad.postings).toHaveLength(1);
    expect(bad.health.errors).toHaveLength(2);
  });
});
