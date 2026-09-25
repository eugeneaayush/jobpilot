# Personal discovery connectors

These modules normalize public job data. They do not call application endpoints, read applicant files, persist records, schedule work, or establish eligibility or permission to submit. All posting text and HTML is untrusted source data; consumers must render safely and must not follow embedded instructions.

## Interface

```ts
discoverLever(boardToken, {
  region: "global", // or "eu"; never inferred or automatically retried elsewhere
  employer: "Configured display name", pageSize: 100, maxPages: 20,
  timeoutMs: 10000, maxResponseBytes: 5000000, retries: 2,
});
discoverAshby(boardToken, { employer, timeoutMs, maxResponseBytes, retries });
normalizeCbsImport(inputText, {
  format: "csv", // or "json"
  sourceUrl: "https://source.example/export", // provenance only; never fetched
  boardToken: "cbs", // caller's stable import namespace
});
```

All accept an optional `now` clock. Network connectors also accept injected `fetch`, `sleep`, and caller `signal` for testing/cancellation. Invalid configuration throws before a request. Runtime source failures return a result. The default network retry count is two (three attempts); the maximum is two. Each attempt has a 10-second default deadline (30 seconds maximum) and a 5 MB response limit (20 MB maximum). GET only, no credentials and no redirects. A 429 or server `Retry-After` stops this run and reports `nextEligibleAt`; callers must persist and enforce it across runs. Other transient errors have 250/500 ms bounded retry delays.

Result keys preserve the existing discovery shape, with `source` widened to `lever | ashby | cbs`. Extra posting metadata includes `sourceRegion`, `locations`, `employerId`, `employerNameSource`, `publishedAt`, `publishedAtMeaning`, and `provenance`. Board tokens identify source tenants, not verified legal entities. `employerNameSource: board_token` expressly marks a display fallback. Unavailable employer, requisition, internal-job IDs and dates stay null. A configured employer display name does not prove a firm match.

`provenance.responseHash` hashes exact response bytes (or UTF-8 import bytes), while posting `contentHash` hashes the retained raw row's JSON serialization. Network `contentHash` on the result hashes the ordered successful-response receipts, including source URL and response hash; it is a manifest hash, not a single-page body hash. CBS result `contentHash` is the original input hash, including BOM and line endings. Receipts include each attempted URL/time/status and successful body hash/byte count. Raw posting objects preserve additional upstream fields.

Suggested durable source identities: `lever:<global|eu>:<boardToken>`, `ashby:<boardToken>`, `cbs:<boardToken>`. Never join employers by fuzzy name or conflate Lever regions.

## Coverage and health

| Result | Meaning |
| --- | --- |
| `complete` | The configured board feed or supplied export was exhausted with no invalid rows. |
| `partial` | Some data was obtained, but rows, pagination, or later requests were incomplete. |
| `blocked` | No usable rows were obtained because access was denied/rate limited. |
| `failed` | No usable rows were obtained due to transport/schema failure. |

`coverage.empty` is true/false only for complete runs; otherwise null. `coverage.observedTotal` counts raw observed rows, including duplicates and excluded unlisted records. `excludedUnlisted` explains Ashby's direct-link exclusions. `exhausted` refers only to the feed/export, not the employer's complete recruiting universe. `expectedTotal` remains null for APIs that do not declare a count; CBS uses supplied row count. Pagination across a changing board is not an atomic snapshot, so even a complete run does not establish that no concurrent posting changed. No result establishes that a job is still accepting applications or that an applicant qualifies.

## Lever

[Official Postings API documentation](https://github.com/lever/postings-api) describes separate global/EU hosts, `skip`/`limit` pagination, published postings, and description sections. The connector includes description, requirement/benefit lists, closing content, and salary description. It verifies each hosted URL's region, board and posting ID, requests the next page after a full page, and stops on a short page. A repeated/oversized page or page cap is partial. Default page size is 100, with at most 20 pages; explicit bounds allow up to 100 pages. Internal postings and custom application questions are not covered. Publication dates and requisition IDs are not invented from undocumented fields. No cross-company or full-text search is provided.

## Ashby

[Official Job Postings API documentation](https://developers.ashbyhq.com/docs/public-job-posting-api) describes a board feed and `includeCompensation=true`. There is no documented pagination for this endpoint. `isListed:false` records are excluded and counted; missing visibility is a row error. A same-board hosted URL supplies posting identity, and any explicit ID must match. `publishedAt` means last published, so `firstPublishedAt` stays null. Full HTML/plain descriptions, secondary locations and raw compensation evidence are retained. No undocumented count, closure time, or employer identity is inferred.

## CBS import

This is an explicit import format, not a claim about an official CBS export schema or an authenticated CBS connector. Supply CSV with a header or JSON as an array / `{ "jobs": [...] }`. Limits: 5 MB and 5,000 rows. Required columns are job ID, title, employer, HTTPS job URL and full description (text or HTML). Exact aliases normalize spaces, underscores, hyphens and case:

| Canonical field | Accepted aliases |
| --- | --- |
| `id` | id, job ID, native ID, posting ID |
| `title` | title, job title |
| `employer` | employer, company, company name |
| `url` | URL, job URL, posting URL, application URL |
| `description` | description, description text, description plain, job description |
| `descriptionHtml` | description HTML |
| optional IDs | employer ID / company ID, requisition ID, internal job ID |
| optional dates | published at / date posted, first published at, updated at, deadline / application deadline |
| `location` | location |

Dates must be ISO dates or ISO timestamps with an explicit timezone. CSV preserves quoted newlines, escaped quotes, and each row's physical starting line. JSON preserves row index; no fictional line numbers. Duplicate IDs, header alias collisions, malformed rows, missing descriptions and ambiguous dates are errors. Provided dates are export assertions, not independent freshness verification. Complete means every supplied row normalized; it never means all CBS opportunities were discovered.

## JobSpy assessment

[JobSpy's maintainer README](https://github.com/speedyapply/JobSpy) describes a Python scraper with board-specific options, limited result requests and optional extra LinkedIn description fetches. It also documents aggressive blocking/429 responses. It could be an optional lead-discovery import, but should not be a default authoritative source or a prerequisite for this API. This is an engineering recommendation, not an upstream guarantee: isolate a future pinned Python worker, capture per-board query/cap/error receipts, require complete description evidence before evaluation, and verify employer/native identity against a primary posting. Empty scraper output must remain unknown unless exhaustion can be proved. Do not inherit proxy rotation or bypass behavior as a recovery policy. No JobSpy dependency was installed or executed here.

## Validation

Run `bun test apps/api/src/modules/personal/discovery-connectors`. Tests use injected responses only and make no external requests. API/persistence integration is owned by the discovery service, outside these modules.
