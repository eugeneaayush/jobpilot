# Private JobPilot implementation ownership

Branch: `codex/private-jobpilot`. Original source inputs remain unmodified and untracked.

## Implementation ownership

- September 20 recruiting bridge: Codex owns the contracts, local importer, recruiting API reader, recruiting panel, synthetic coverage, and integration validation. The attached Claude Code session independently reviews this scope without implementation edits or private applicant inputs. Future changes to these recruiting files remain Codex-owned until explicitly handed off.

- Codex root: setup/runtime scripts, privacy, personal API integration, broker, end-to-end validation and documentation.
- Codex persistence worker: personal Prisma models/migration, attempt contracts/service/controller/tests, exact URL guard and legacy personal-mode safety.
- Codex résumé/discovery worker: pure intake/discovery/evaluation/document modules and tests under API personal module.
- Codex terminal worker: terminal Workers module, endpoints/DI, worker tests.
- Claude Code in PyCharm: bounded dashboard/components/API client tasks, followed by read-only reviews. UI-007 adds optional internship/category campaign controls and synthetic UI tests; UI-008 owns country-scoped authorization and availability-note settings. Codex owns contracts, API guards, private résumé adjudication, and final integrated review. Private applicant data is not part of these Claude assignments.

## Dashboard contract

Use `@jobpilot/contracts/personal` for schemas and inferred types. All routes authenticated under `/api/personal`:

- GET `/` with standard page/pageSize and optional track returns personalDashboardSchema.
- POST `/intake` (no body) returns personalIntakeResponseSchema; imports configured local source.
- POST `/discover` body personalDiscoverSchema returns personalDiscoveryResponseSchema.
- POST `/:id/preview` (no body) returns personalRecordSchema; offline only.
- GET `/:id/pdf` streams the exact private PDF, never a public capability link.
- GET/PUT `/settings` uses personalSettingsSchema.

The root route `/personal` is an authenticated dashboard page within the existing shell. Three explicit recruiting tracks, separate eligibility/fit, durable state, source health, document readiness, original hashes, missing inputs, and offline-vs-live labels. No real-submit UI until API reports capability. Preview records never count as submitted applications.

## Delivery gates

Private setup, original hashes, source enumeration, intake, factual conflicts, PDF visual QA, offline preview, database restart persistence, synthetic application recovery, ordered repository checks. No real applications or recruiter messages during development.

## Verified checks (2026-09-15)

Biome CI, knip, API/web/runtime TypeScript checks passed. API: 776 passed (opt-in PostgreSQL cases run separately); PostgreSQL integration: all 45 passed separately; contracts: 7 passed; terminal: 317 passed; browser component regressions: 23 passed. The prior Terminal Release publish and real Codex/Claude synthetic probes remain recorded in private verification receipts. New tests cover internship scope at reservation and submission, country-scoped answers, and settings preservation.

Runtime receipts, screenshots, original hashes, and exact inspected PDFs are outside this repository under the private runtime root. Outstanding source conflicts were resolved through a delegated, hash-pinned source-selection and omission audit; this is not independent employment verification. Historical draft artifacts remain immutable. Employer-specific eligibility, answers, attachments, and browser support are separate gates. Private-owner routing denies valid foreign accounts, and personal-mode registration is disabled. No source résumé or runtime credential is tracked.

## Recovery and attachments delivery (2026-09-16)

Claude Code delivered UI-009A through UI-009D under exclusive dashboard/test ownership. Codex integrated source-cited eligibility decisions, screening snapshot invalidation, required-file inventory, deterministic cover-letter generation, immutable per-file review, blocked-job recovery, and an authenticated terminal-owned browser handoff. New broker upload tools use opaque handles; exact file bytes and observed answers are checked again at the final request boundary. MCP configuration is constructed as fixed local stdio rather than inheriting template transport fields.

Current verification: Biome, knip, API/web/runtime types pass; API 827, separate PostgreSQL integration 61, contracts 7, terminal 330, dashboard browser 41, pilot 3 all pass. Native terminal Release publication passes. Private receipts include restart persistence and exact inspected document hashes; no applicant data belongs in this log.

Read-only employer inspection found hosted Greenhouse React controls, staged uploads and cross-origin JSON submission outside the current native-form broker. This now causes an explicit unsupported-portal hold, not a misleading login loop. The next milestone is that dedicated adapter and synthetic challenge/receipt tests. No real application submission or recruiter outreach occurred. Real campaigns remain stopped.

## Hosted Greenhouse delivery (2026-09-16)

The earlier unsupported-form milestone is implemented by a dedicated local driver. It verifies posting identity, waits for the published React application to become interactive, maps exact observed controls and approved dropdown choices, validates signed upload fields and file bytes, and freezes the full final JSON request before forwarding it once. Public confirmation pages alone never establish submission. Unknown fields, consent, authentication, or changed source state remain individual application holds.

Known email-verification responses keep the original attempt and reservation. The private dashboard sends an explicitly entered code through a bearer-authenticated local continuation endpoint; the continuation changes only the frozen credential envelope, consumes one permit, and requires correlated transport evidence. Neither retries nor browser handoffs reopen uncertain submissions automatically. Verification request evidence remains in private runtime storage.

Claude Code completed GH-UI-011/012 under exclusive dashboard and synthetic-test ownership. Root reviewed the privacy wording, stale lease controls, code clearing, and the distinction between submit intent and confirmed submission. Private applicant information was not part of these assignments. The configured worker remains restricted to opaque metadata; changed broker code requires a new hash-bound verification receipt.

Screening provenance now supports narrowly defined, deterministic formatting of current résumé facts for school, MBA degree, graduation month/year, US location, and phone-country controls. Declining voluntary demographic questions is recorded as a delegated privacy preference, never as a personal trait or consent.

Verification: Biome, knip, API/web/runtime types pass; API 928, separate PostgreSQL integration 67, contracts 7, terminal 330, dashboard browser 45, and pilot 3 pass. Real Chromium driver tests inject all employer responses; live source probes read empty forms only. The latest private PDFs were rendered and inspected; their exact hashes and campaign execution outcomes are recorded only in private runtime receipts. Live application execution is separate from these development checks.

### Hosted-form recovery follow-up

The first production inspection exposed legacy-host hydration and a shared local rate-limit bucket before any applicant field or document was transmitted. The adapter now enters the same frozen posting on the hosted origin, rejects transport redirects, and records redacted private diagnostics. Reads and heartbeats have independent bounded budgets; submission mutations retain their existing tighter limits.

Claude's GH-UI-013 review identified stale browser-session upload state and an unbounded shutdown wait. Reopening before submission now clears preparation evidence; a driver that sent a request cannot reopen. Revoked preparation authority is checked before any browser navigation, cleanup is idempotent, and broker shutdown has a ten-second deadline. Synthetic tests cover legacy URLs, redirects, session reset, failed-open cleanup, diagnostics, and control-request capacity. Historical attempts and stale-lock review receipts remain private and immutable.

Final follow-up checks: CI, knip and API/web/runtime types pass. All 122 API test files ran exactly once with 947 passing and 93 opt-in database cases skipped; browser-launch suites ran in six separate Bun processes after intermittent Chromium transport failures in the monolithic runner. All seven processes passed without retries. PostgreSQL integration 67, contracts 7, terminal 330, dashboard browser 45 and pilot 3 remain verified for this delivery. The hosted driver has 13 synthetic Chromium tests. Real campaign outcomes and any outstanding employer consent or verification holds are recorded in the private dashboard, separately from test results.

### Hosted control and process completion corrections

Greenhouse can prefetch signed attachment fields during React hydration, before a file control is inspected. The adapter accepts the two built-in attachment metadata requests at that stage, still requires exact approved file bytes before any storage upload, and blocks further presign requests after the final submission boundary. Phone-country controls can display only a flag and shared dialing prefix; both must correlate to one observed menu choice.

Greenhouse's renderer also waits for an upload-progress event after storage succeeds. Intercepted browser requests omit that native event. A local bridge reports completion to one captured, finished, successful storage XHR only after the host has validated and forwarded the exact multipart bytes. The driver then waits for the exact filename and remove control; an HTTP success alone does not establish that the document is ready. Synthetic tests exercise this progress-dependent renderer, and a public-form probe uses local synthetic upload responses with all external writes blocked.

Final form inspection distinguishes an ambiguous selected answer from unrelated duplicate labels elsewhere in a lookup menu. Exact observed option values may disambiguate an answer; conflicting source identifiers are never chosen by label alone.

The terminal host checks for abandoned browser ownership after a worker process exits. It can quarantine a matching dead pre-submission owner only after verifying the API attempt, lease generation, absent browser locks, and an idle profile. Live, uncertain, mismatched, or post-submission ownership remains held. Quarantine preserves the original lock and a private audit record; it does not retry an application or change its ledger state.

Application files uploaded during an authorized live campaign count as employer transmissions even when the final application remains blocked. Submission counts require a confirmed receipt. These outcomes are kept separate from synthetic development tests and recorded in the private dashboard.

### Disconnected worker recovery and handoff review

The supervisor retains an unresolved submitting task until an authoritative API read confirms its outcome. Worker exit, stop, and deadline paths use the original lease fence to record uncertainty; a failed transition or read-back cannot discard the task. Restart-safe counters limit automatic pre-submission resumes to two and cancellation requests to three per endpoint, with backoff. Exhausted cancellation budgets switch to status reads. A terminal 404 cannot recreate an execution that has crossed the submission boundary.

The MCP process records only fixed lifecycle events, operation names, attempt ID, PID, time, and exit code in bounded private logs. It flushes exit events synchronously and waits for redacted fatal diagnostics within its existing shutdown deadline. New tool calls are rejected after shutdown begins. Synthetic subprocess tests exercise real stdin closure and SIGTERM, with no applicant data.

A saved submit intent alone does not establish an employer transmission. The hosted adapter must commit its immutable transport ledger before forwarding the final POST. A manual negative reconciliation requires a fresh authoritative read after all worker/browser activity has stopped, an intact audited execution/database, and proof that the guarded route was the only submission path. Missing email or an old snapshot is insufficient. A persisted transport remains held for correlated reconciliation; it is never released merely because a request timed out.

Login handoffs now reject every mutation-response redirect. Synthetic tests reproduce and prevent 307/308 redirects that could otherwise preserve an authentication POST at an application URL. Direct authorized authentication responses and separately reviewed navigation remain supported.
