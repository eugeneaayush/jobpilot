import { parseLeadFeed } from "./feed-parser";
import { describe, expect, test } from "bun:test";

const now = new Date("2026-09-30T12:00:00Z");
const options = {
  feed: "summer_internships" as const,
  format: "json" as const,
  sourceUrl: "https://github.com/example/internships",
  seasonYear: 2027,
  season: "summer" as const,
  maxAgeDays: 120,
  now,
};
const row = {
  id: "synthetic-1",
  company_name: "Example",
  title: "Summer 2027 MBA Intern",
  url: "https://jobs.lever.co/example/123?utm_source=feed",
  locations: ["New York"],
  active: true,
  is_visible: true,
  date_posted: Date.parse("2026-09-20T12:00:00Z") / 1000,
  terms: ["Summer 2027"],
  degrees: ["MBA"],
};

describe("independent recruiting feed parser", () => {
  test("filters inactive, hidden, stale and wrong season rows without using degree eligibility", () => {
    const result = parseLeadFeed(
      JSON.stringify([
        row,
        { ...row, id: "inactive", active: false },
        { ...row, id: "hidden", is_visible: false },
        { ...row, id: "old", date_posted: 1 },
        { ...row, id: "year", terms: ["Summer 2026"] },
        { ...row, id: "spring", terms: ["Spring 2027"] },
      ]),
      options,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.excluded).toBe(5);
    expect(result.candidates[0]).toMatchObject({
      sourceRowId: "synthetic-1",
      postedAt: "2026-09-20T12:00:00.000Z",
      candidateDestinationUrl: "https://jobs.lever.co/example/123",
    });
    expect(result.candidates[0]).not.toHaveProperty("eligibility");
  });
  test("keeps unknown dates explicit, rejects malformed rows, deduplicates destinations", () => {
    const result = parseLeadFeed(
      JSON.stringify([
        { ...row, date_posted: null },
        { ...row, id: "duplicate" },
        { ...row, id: "bad", url: "javascript:alert(1)" },
        { ...row, id: "unconfirmed", active: undefined },
      ]),
      options,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.postedAt).toBeNull();
    expect(result.duplicates).toBe(1);
    expect(result.diagnostics.some((value) => value.includes("Row 3"))).toBe(true);
    expect(result.status).toBe("partial");
  });
  test("parses multiple HTML tables, direct ATS links, continuation rows, dates and closed roles", () => {
    const html = `<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead><tbody>
<tr><td><b>Example &amp; Co</b></td><td>MBA Intern</td><td>NYC</td><td><a href="https://jobs.lever.co/example/one?utm_source=feed"><img alt="Apply"></a><a href="https://simplify.jobs/p/one">Simplify</a></td><td>3d</td></tr>
<tr><td>↳</td><td>Investment Intern</td><td>NYC</td><td><a href="https://jobs.ashbyhq.com/example/two/application?embed=true&amp;utm_source=feed">Apply</a></td><td>Sep 25</td></tr>
<tr><td>↳</td><td>Closed MBA Intern</td><td>NYC</td><td>🔒</td><td>Sep 24</td></tr></tbody></table>
<table><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr><tr><td>↳</td><td>Orphan</td><td>NYC</td><td><a href="https://jobs.lever.co/example/orphan">Apply</a></td><td>2d</td></tr><tr><td>Second</td><td>Spring 2027 Intern</td><td>NYC</td><td><a href="https://jobs.lever.co/second/spring">Apply</a></td><td>2d</td></tr></table>`;
    const result = parseLeadFeed(html, { ...options, format: "readme_html" });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]?.companyHint).toBe("Example & Co");
    expect(result.candidates[1]?.candidateDestinationUrl).toBe(
      "https://jobs.ashbyhq.com/example/two/application?embed=true",
    );
    expect(result.candidates[0]?.sourceDateText).toBe("3d");
    expect(result.candidates[0]?.postedAt).toBeNull();
    expect(result.excluded).toBe(3);
  });
  test("missing recognizable table or invalid JSON is failed, empty list is complete", () => {
    expect(parseLeadFeed("broken", options).status).toBe("failed");
    expect(parseLeadFeed("[]", options).status).toBe("complete");
    expect(parseLeadFeed("# no tables", { ...options, format: "readme_html" }).status).toBe(
      "failed",
    );
  });
});
