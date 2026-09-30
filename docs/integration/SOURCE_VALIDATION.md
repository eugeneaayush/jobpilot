# Optional discovery source validation

Executed September 30, 2026, 09:57 EDT (`America/New_York`), against JobPilot commit
`cb1c8c2f67a9c164beb25840cdf50509dbbf8070`. This report records read-only availability
and parser observations. It does not enable any optional source, authorize an
application, or establish job freshness, employer identity, or applicant eligibility.

## Method and scope

The installed, locked Python dispatcher received one `capabilities` request and one
`discover_jobs` request per board, sequentially. Every discovery request used query
`MBA finance`, location `New York`, limit `5`, and protocol version `1`. A fixed
`.venv/bin/python -m jobpilot_local_tools` argument array ran in a separate mode-0700
temporary directory with a minimal environment, no credentials, no proxy variables,
and a 120-second subprocess deadline. The existing adapter issued one ordinary HTTP
GET per board, with a transparent user agent, a 25-second HTTP timeout, no redirects,
and a 2,000,000-byte response limit.

No retry, job-description crawl, official-posting resolution, login, browser,
impersonation, proxy, paid service, database, application endpoint, or configuration
mutation was used. No recruiter or employer message was sent. Stagehand remains
deferred and was not installed or executed for this validation.

All four request/response pairs passed the shared Zod schemas after the Python
dispatcher validated its own Pydantic result. Request IDs and operations matched.
Each saved raw response snapshot matched its returned SHA-256 and size bound; all
subprocesses exited successfully with zero stderr bytes. Full HTML and normalized
lead payloads remain private temporary evidence outside the repository, not committed
datasets. The protocol reports a typed source outcome, not response headers or exact
HTTP status; this report does not infer a specific 403, 429, challenge, or redirect.

## Live board observations

Times below are UTC on September 30, 2026. `complete` means the adapter parsed the
bounded response successfully; it does not mean the board was exhaustively searched
or any lead was promoted to a verified posting.

| Board | Probe start/end UTC | Seconds | Source outcome | Leads | Cooldown | Diagnostics | Disposition |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| LinkedIn | 13:57:18.263502–13:57:18.945934 | 0.682 | `complete` | 5 | none | none | Ordinary HTTP returned parseable leads. All five remain `unresolved`, with LinkedIn original URLs and no candidate official destination. Keep disabled until explicit per-source configuration and official resolution checks. |
| Indeed | 13:57:18.947596–13:57:19.103293 | 0.156 | `blocked` | 0 | 3,600 seconds | `source_blocked`: Source denied or challenged ordinary HTTP access | Keep disabled; preserve blocked evidence and cooldown. No fallback or retry was attempted. |
| Google | 13:57:19.103738–13:57:19.271897 | 0.168 | `blocked` | 0 | 3,600 seconds | `source_blocked`: Source denied or challenged ordinary HTTP access | Keep disabled; preserve blocked evidence and cooldown. No fallback or retry was attempted. |

Envelope status was `ok` for each board, including the blocked outcomes: the bounded
operation completed and reported a source failure normally. It does not imply source
availability. Partial success was preserved: LinkedIn results survived both other
boards being blocked.

| Board | Snapshot bytes | Raw response SHA-256 | Protocol response SHA-256 |
| --- | ---: | --- | --- |
| LinkedIn | 30,539 | `a5a26ad489e63e3d9b714ddbf201762554b56b4b4ec0ffe0d59e7813aa442566` | `9819a7af98914cdbd21c433854416b929a382c909ae19eebd5d7fa8b4ff3bb1d` |
| Indeed | 27,656 | `3ece2ce3af4b57fe027c8b48e99ff0183b36afa674160256a039093624401aaf` | `4596a560adcecb4608e7d186333957433bf8a53f6aef97d103d0dec16a3d630a` |
| Google | 259 | `621592c9abbdc94586409477d74d4d2583472765f564b7c711a07314f17b3200` | `8ab25257815e1f1b5fb8b4a8ea19b4870bff53b98d73796b7d09b1be013134f8` |

The LinkedIn guest-search endpoint was
`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`;
Indeed used `https://www.indeed.com/jobs`; Google used
`https://www.google.com/search` with its job-search parameter. A single probe from
this network does not establish reliable access from other networks or later dates.
Glassdoor and ZipRecruiter remain unavailable and were not probed.

## Offline feed observations

These checks used the existing audited local checkouts only. No feed network request
or upstream refresh occurred, and the observations do not establish current live-feed
availability. Only shape, count, hashes, and parser diagnostics are recorded here;
no rows or datasets were copied into JobPilot.

| Feed | Audited checkout SHA | Full JSON bytes/rows | Existing JSON parser outcome | README bytes/parser outcome |
| --- | --- | --- | --- | --- |
| New-Grad-Positions | `c4b52dc057ed53cef081d4cd5f913c4392565421` | 13,420,718 / 19,671 | `failed`: Feed snapshot exceeds 2 MB | 714,904 / `partial`: 200 candidates, 2,176 excluded, 0 duplicates |
| Summer2027-Internships | `d648ee167b953cb3f5aedfdc0208c033e03f1c6e` | 12,763,150 / 16,966 | `failed`: Feed snapshot exceeds 2 MB | 1,201,410 / `partial`: 200 candidates, 1,782 excluded, 0 duplicates |

Both structured snapshots are JSON arrays with the expected identity, company, URL,
active, visibility, dates, and location fields; the internship snapshot also has
`terms`. Both exceed the current 2,000,000-byte and 10,000-row limits. The byte guard
rejects them before row parsing. Direct whole-JSON ingestion of these audited files
is therefore unsupported in this version. The limits were not weakened.

The existing README HTML parser accepted both bounded audited snapshots. It used
season year `2027`, maximum age `120` days, and an explicit clock of
`2026-09-30T13:57:18Z`; new-grad used season `any`, internships used `summer`.
Both reached the 200-lead cap and reported `Feed batch capped at 200 leads`.
New-grad also rejected row 168, and internships rows 366 and 1477, for URLs lacking
a permitted public HTTPS destination. All 200 retained candidates in each HTML
result had unknown `postedAt`; relative date strings remain source hints, so these
results do not prove freshness. No degree flag was converted into graduate eligibility.

| Feed | JSON snapshot SHA-256 | README snapshot SHA-256 |
| --- | --- | --- |
| New-Grad-Positions | `352151bf7f4d8782652db420b73991f71c07ec3ef01a0c546bf3191723b94a72` | `a0985891f73bc1dd311902560cbf0408f2fbcf6eb6ecacb3719439aba65ac784` |
| Summer2027-Internships | `9b0678960d95993867bf05bbbf7e133452cd4cfd754c0df15ad96f0a0817b7a8` | `3f0e573e987f549a13196d299e562091c767ed701e4faeea9d39b9623dcc1a0b` |

Neither feed has a tracked license in the audited snapshots. They remain optional
private input formats; no updater or dataset is redistributed. Later use requires a
bounded private snapshot, such as the supported README HTML or a deliberately bounded
JSON selection, rather than automatic import of the complete structured repository.

## Component evidence

The `capabilities` request ran at `2026-09-30T13:57:18.201704Z` and completed at
`2026-09-30T13:57:18.263099Z`. Its envelope SHA-256 was
`f7f231f945af256657647e099ecca6c9c52ac9681c4b6a134ddbcebee40590c6`.

| Component | Installed version |
| --- | --- |
| Python | 3.12.14 |
| jobpilot-local-tools | 1.0.0 |
| jobpilot-jobspy | 1.0.0 |
| httpx | 0.28.1 |
| Pydantic | 2.12.5 |
| RenderCV | 2.8 |
| rendercv-fonts | 0.5.1 |
| Typst | 0.15.0 |
| pypdf | 6.7.5 |
| Verifier protocol | 1 |

The locked environment SHA-256 was
`f3dfb827b6dcfc3948fde9531225c373576bf2b789560b579cd737d6ae0e2df8`
for `services/local-tools/uv.lock`. Discovery implementation SHA-256 was
`b5380013a277e3441fa1b8ed2b7e713a06c7d7bb7cb3f72783b96eaad450cc92`;
feed parser SHA-256 was
`d83dc7c844d3ca3947d091c3c06c3022fa09b3ba72a852aee296d473b11a89bd`.
Renderer presence in capabilities does not imply that this source probe rendered a
document or exercised application preparation.

## Later enablement criteria

- Enable an optional source individually through the private configuration only after
  source access expectations and its recorded outcome are reviewed. Keep Indeed and
  Google disabled while ordinary HTTP access is blocked; honor cooldowns rather than
  adding alternate transports.
- Treat parseable LinkedIn results and feed candidates as unresolved leads. Resolve
  complete official employer/ATS postings through an already supported source,
  establish employer and requisition identity, and require registration and campaign
  source scope before existing freshness, deduplication, and eligibility checks.
- Use bounded private feed snapshots. Whole audited JSON files currently fail the
  ingestion bounds; bounded README HTML demonstrates parser compatibility only.
  Unknown posting dates require primary-source verification, and the 200-candidate
  cap is a partial outcome, not exhaustive discovery.
- Keep document preparation, exact application approval, provider verification,
  caps, and submission authority separate from discovery. A source result can never
  make a job application-ready or waive an approval.
- Revalidate a source after an adapter or upstream format change, using limited
  read-only requests and synthetic regression fixtures. This report claims one
  network observation per board and audited-snapshot parser checks, not durable
  coverage of every location, query, posting, or provider.

Stagehand's separate fixture benchmark and production go/no-go decision remain
outstanding. No browser fallback was required or activated here.
