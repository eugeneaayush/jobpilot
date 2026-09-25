# Graduate and experienced-hire implementation

Approved scope: worldwide tracked discovery, graduate recruiting and comparable experienced
professional roles; undergraduate entry-level roles excluded. Source-grounded eligibility is
separate from fit priority. Mixed student programs need affirmative graduate-level evidence.
No claim of complete Internet coverage or guaranteed ATS selection.

## Implemented behavior

- Source-grounded graduate / experienced-professional classification at preparation, reservation,
  final submission and continuation. Undergraduate entry-level and unresolved level are held.
- Explicit availability, paid-work, language and jurisdiction requirements are separate from fit.
  Fit orders the queue; it does not reject otherwise eligible roles. Urgent verified deadlines
  come first, followed by investing, product management, MBB and other roles.
- Atomic user-wide limits: 50 applications/day in America/New_York, three active applications
  per canonical employer, and lower configured employer limits. Possible submissions retain
  capacity. Same-requisition reservations survive campaign changes and restarts.
- A pre-submission blocked attempt can recover into an already-authorized active campaign.
  Recovery retains the original attempt and campaign, checks fresh source evidence and the
  target scope, and invalidates the old preparation. Explicit transfers are bound to the target
  run; reissuing an unconsumed stale ticket requires newer evidence. Possible submissions cannot
  transfer until reconciled, and changing campaigns never resets the true-failure retry limit.
  The recovery dialog can select a target from paginated active campaigns. Changing targets
  clears old drafts and proof; a stale-context response reloads evidence before another request.
  Reassessment preserves reviewed eligibility and recovery evidence only while their exact
  posting, facts and requirements remain unchanged.
- After campaign authorization is checked, polling refreshes at most 25 stale source-scoped
  records before eligibility and track filtering. Unchanged records are left untouched; active
  attempts and claimed preparation defer refresh. Blocked jobs retain their recovery history.
  Direct preparation also checks freshness. A legacy preview survives initial context stamping
  only when its complete preparation inputs and raw eligibility assessment still match.
  Crossing a verified application deadline also makes eligibility stale. The dashboard shows
  stale or unavailable eligibility separately from document readiness; visual review is bound
  to the exact record and PDF hash opened.
  Evaluator revisions make prior eligibility stamps stale. Discovery can preserve an active
  manual decision only when its recorded evidence context exactly matches the newly evaluated
  requirements; historical decisions alone cannot restore it. Attempt creation, preparation
  and final submission check the current context, so a lease cannot bypass a parser upgrade.
  Receipt recording and reconciliation remain available for possible submissions.
  The supported "This role will remain open until" notice is evaluated as an employer
  deadline, with its original quotation retained. Malformed dates remain source holds;
  a date without a closing time or timezone becomes uncertain during its possible closing
  window. Crossing that window invalidates freshness. Other deadline phrasings still need
  source review; unsupported extraction does not prove there is no deadline.
- Greenhouse, Lever and Ashby public-board discovery plus CBS CSV imports, with source health,
  pagination/coverage receipts, durable cooldowns and distinct empty/partial/failed outcomes.
- Paginated source registry and evidence-backed employer aliases. Unverified legacy aliases
  require review. Cross-ATS deduplication needs a shared requisition identifier and established
  employer identity; different unknown identifiers are not guessed equivalent.
- Configured Brave search returns unverified URL candidates. It reserves search spending in a
  transaction against the $50 search and $200 total monthly budgets. Missing credentials are
  reported as setup gaps; snippets never establish eligibility or full-market coverage.
- Isolated Codex full-description résumé proposals cite immutable facts. Independent grounded
  review is required for paraphrases; stale facts, changed metrics and unsupported claims hold.
  Reviewed essay claims can feed a cover letter. PDF and DOCX exports remain immutable and
  need document-specific rendering review. Graduate/MBB/investing résumés are limited to one
  page; other experienced roles permit two. Oversized output stays draft.
- Active campaigns advance one durable preparation phase at a time: proposal, independent
  claim review in a fresh session, PDF creation, and independent visual review of every rendered
  page. Source changes restart the affected phase; stopped campaigns cancel ongoing review.
  A user has one preparation slot, a six-minute phase deadline and at most three attempts per
  unchanged phase, with an hour between failures. Layout holds never become ready automatically.
  Local `pdftoppm` and `pdftotext` are required for automated PDF inspection.
- Successful preparation phases resume by record ID, independently of idle application polling.
  Continuations retain their campaign run, yield after four advances, and preserve source
  cooldowns and retry history across restarts.
  Failed final checkpoints release only their own preparation claim, preserving newer edits
  and saved artifacts. Other jobs can continue while that document remains held.
- Tailoring and review use verified ChatGPT subscription authentication and included usage.
  The pinned Codex protocol has no per-turn paid-credit prohibition, so any available, unlimited,
  or unknown paid-credit state holds. No paid API fallback is enabled.
- Official application-email preparation verifies the recipient against posting evidence and
  freezes exact MIME/attachment hashes. A mail provider accepting a message does not prove
  employer receipt. Interrupted dispatch reconciles without resending. OAuth setup is required.
  Exhausted reconciliation stops local tracking only after a known lease expiry or an
  authoritative settled state; the server reservation continues preventing resubmission.
- Greenhouse hosted forms and a restricted Lever native multipart adapter use one-use submit
  authority and frozen request bytes. Lever currently has no verified confirmation oracle:
  even a successful HTTP response remains uncertain until correlated employer evidence exists.
  Visible login, OTP or CAPTCHA controls on the exact authorized Greenhouse posting page enter
  the durable handoff flow even when the application form has not loaded. Hidden controls,
  unexplained missing forms, external redirects and mismatched posting identities do not qualify.
- Persistent polling/backoff separates reads, discovery, mutations and worker control. Stopped
  campaigns still receive the local daily digest, due at 18:00 America/New_York when the Mac
  and process are running. Digest counters distinguish new discoveries from current states.

## Commands

Run from the repository root. All private input/result files belong outside the checkout.

```sh
bun run personal:doctor
bun run personal:setup
bun run personal:dev
bun run personal:registry
bun run personal:discover /absolute/private/path/source.json
bun run personal:search 'MBA internship careers'
bun run personal:reassess
bun run personal:tailor RECORD_UUID
bun run personal:tailor-review RECORD_UUID /absolute/private/path/claim-review.json
bun run personal:digest
```

On macOS, install missing PDF-inspection tools with `brew install poppler`; other hosts need
Poppler's `pdftoppm` and `pdftotext` on `PATH`. `personal:doctor` reports missing binaries.

Discovery input examples (public identifiers, not applicant data):

```json
{"source":"ashby","boardToken":"configured-employer","employer":"Employer"}
```

Lever adds `region: "global"` or `"eu"`; CBS accepts the bounded CSV import fields described by
`personalDiscoverSchema` in `packages/contracts/src/personal.ts`. `personal:preview` remains an
explicit offline preparation operation; it does not authorize a campaign. Start a configured
campaign from the authenticated local dashboard after its readiness checks pass. The stop
control revokes future work; uncertain submissions remain reserved for reconciliation.

Private `runtime.json` can contain `employerPolicies` entries with a canonical employer,
`maxActiveApplications` from 0 to 3, and source URL/hash/quote plus an explicit owner attestation.
The API validates the shape; that attestation is not a claim of fresh server-side source review.
Stricter caps are checked again at continuation. Existing submitted applications currently count
until a separate closed/withdrawn lifecycle is implemented.

## Operational boundaries

Source coverage is limited to configured boards, imports and configured search queries.
The pilot rotates active campaigns' authorized sources, persists source cooldowns and registry
pagination, and rechecks campaign authorization before each outbound page. Explicit runtime
search queries run at most once per day, only while their campaign is active; search results
remain unverified candidates. Configure them outside the repository in `runtime.json`:

```json
{"pilotDiscovery":{"queries":[{"campaignId":"CAMPAIGN_UUID","query":"MBA internship careers","maxPages":3,"pageSize":20}]}}
```

The dashboard search button runs one manual search and does not create that schedule.
Workday, arbitrary custom portals and Ashby hosted submission are not universal supported flows;
unsupported forms park. JobSpy remains optional discovery research, not an authoritative employer
source. Search requires provider configuration; official email requires the user's OAuth account.
Account credentials, verification codes and binding agreements use the existing user handoff.
An employer form can transmit fields and uploads before its final submit action. These are live
transmissions, not offline previews. A newly observed required consent or missing answer parks
the affected application. Preserve its worker trace and frozen artifacts, resolve the exact
question, then recover with a new answer snapshot. A worker outcome labelled unknown alone
does not prove submission: reconcile it against the durable submit boundary and broker receipt.

New facts, arbitrary essay questions and exact employer date requirements are never invented.
Graduation-year facts cannot establish month-specific graduation requirements. Exact month
alternatives and date boundaries remain unknown until source-backed review; inclusive year-only
ranges remain distinct from discrete graduation-year alternatives.
An explicit internship start month plus a fixed week duration can establish availability only
when the entire possible start-month interval and duration fit the approved months. The result
retains both source excerpts and labels the inference; it does not invent exact employer dates.
Benefits, equal-opportunity language and negated travel requirements do not become eligibility
restrictions. Genuine mandatory requirements remain separately reviewable.
"You have" and "We prefer" sections separate minimums from preferences, while explicit required
qualifications and employer sponsorship restrictions remain binding even in a preferred section.
MBA enrollment alone does not establish a required study focus or domain-specific experience.
Adjacent wage labels and monetary ranges retain their exact source evidence; explicit unpaid
or uncompensated employment takes precedence over a conflicting positive wage block.
Independent claim review and document render review are durable workflow stages, not assertions
that every discovered job has been fully prepared. Live applications require all eligibility,
answer, attachment, scope and transport gates to pass. Testing uses synthetic submissions only.

## Development boundaries

Existing uncommitted work and historical attempts remain intact. Testing uses synthetic
forms; no real submission is a test. Applicant data remains in private runtime storage.
Claude Code in PyCharm receives code and synthetic tasks only; professional-fact tailoring
uses the approved OpenAI provider. Contact assets are read-only inputs from mba-buyside;
recruiter outreach is a separate authorization from official applications.

## Verification

Run focused tests during each stage, then Biome CI, knip, API/web/personal typechecks,
API/contracts tests, PostgreSQL race tests and terminal tests. Browser suites run in isolated
processes. Assert crash/uncertainty recovery, exact artifact hashes and offline no-network
behavior. Persist migration and validation receipts in private runtime storage.

The latest gate passed 1,433 API tests, seven contract tests and 385 terminal tests, plus
Biome, knip and API/web/personal typechecks. Separately, 147 PostgreSQL integration tests
passed, including the final discovery-refresh regression. The earlier unchanged dashboard
suite passed 69 synthetic browser tests. The API runner inventories every test file once
and isolates browser suites in fresh processes; database-gated skips are verified separately.
Actual approved-provider factual and rendered-page reviews passed for several private
tailored PDFs. Document readiness remains separate from application eligibility and required
answers. No employer application was submitted as a test.

Private-stack restart checks cover authenticated records, reviewed PDFs and campaign history.
These checks establish local execution readiness; they do not establish eligibility or
submission readiness for every posting. Next operational work is to configure search/OAuth
where needed, expand verified employer sources and resolve each remaining factual or security
hold. Campaign status and confirmed submissions must be read from the private dashboard.
