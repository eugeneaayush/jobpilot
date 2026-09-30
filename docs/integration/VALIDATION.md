# Integration validation

Executed September 30, 2026. This report records current checks, not historical test counts.
This report accompanies the committed core milestone 0–10 implementation on
`codex/integrate-private-workflow`, based on
`2155f5266b71b16f3b18460f35a31b44efd68508`. No deployment or private campaign relaunch
was performed. The implementation is published in [PR #1](https://github.com/eugeneaayush/jobpilot/pull/1).
Post-publication preparation and read-only source probes are recorded separately in
[PRIVATE_ROLLOUT.md](PRIVATE_ROLLOUT.md) and [SOURCE_VALIDATION.md](SOURCE_VALIDATION.md).

## Environment and baseline

The original checkout was clean on `main`. Bun was absent from PATH; an isolated official
Bun 1.4.2 installation outside the checkout enabled dependency installation and verification.
The first focused executable baseline passed 95 tests. The locked dependencies were installed
without changing `bun.lock`.

Validation used macOS arm64, Bun 1.4.2, Python 3.12.14, uv 0.12.19, PostgreSQL 17.11,
.NET SDK 10.0.401, Poppler and Playwright Chromium. Python dependencies come from
`services/local-tools/uv.lock`, including RenderCV 2.8, Typst 0.15.0 and the recorded fonts
distribution. See [COMPONENTS.md](COMPONENTS.md) for provenance and license inventory.

PostgreSQL tests used a disposable localhost instance on port 54799 and generated isolated
schemas. Fixtures create synthetic applicants, sources, employers, campaigns and receipts;
they clean up their schemas and private temporary storage. The approval migration was
exercised only in these synthetic schemas. No production/private database migration ran.

## Executed checks

The repository's ordered verify gate passed: Biome → knip → API types → web types → API
tests → contracts tests → terminal tests. Additional applicable checks also passed.

| Check | Result |
| --- | --- |
| `bun run ci` | Passed; no warnings or formatting changes required. |
| `bun run knip` | Passed. |
| API and web typechecks | Passed. |
| Complete isolated API test runner | **1,751 passed, 0 failed, 0 skipped**, 212 files, 19 processes. |
| PostgreSQL integration/race subset | **162 passed**, all 29 files; included in the complete API count. |
| Shared contracts tests/typecheck | **7 tests passed**; typecheck passed. |
| `bun run personal:typecheck` | Passed. |
| Private supervisor/script tests | **134 passed**, 14 files. |
| Locked Python pytest suite | **60 passed**. |
| Synthetic personal-dashboard Playwright suite | **74 passed**, including exact approval/staleness and complete multiselect confirmation. |
| `dotnet test tests/JobPilot.Terminal.Tests` | **417 passed, 0 skipped**. |
| API production build | Passed, including Prisma generation and the Windows x64 compiled Bun artifact. |
| Web production build | Passed. |
| Terminal Native AOT publish | Passed for `osx-arm64`; required provider/worker assets verified. |
| Claude/Codex marketplace staging | Passed against temporary fixture destinations. |
| `bun run personal:tools:setup` | Passed; frozen Python setup and bounded capability request. |
| `git diff --check` | Passed. |

The complete API runner uses a fresh process for each browser suite and covers every selected
file once. Final runs had no retries hiding failures. Early integration failures were corrected
with source/readback fixes, current explicit approval and pipeline metadata in fixtures, and
updated expectations for newly exposed choice metadata. No readiness or approval guard was
removed to make tests pass.

## Evidence and acceptance boundaries

- **Approval:** cookie-only grants, bearer/PAT rejection, configured origin/session nonce,
  stale packets, races, expiry, withdrawal, changed materials and attempt binding are tested.
  Broker requests, authentication handoffs, uploads and final transports recheck current
  authority. Withdrawal also fences an already-open authentication handoff. Posting refresh
  preserves append-only approval history. Uncertain submissions retain their reservations.
- **Migration:** synthetic evidence confirms old live campaigns stop and lose launch authority
  while attempts, uncertain history, reservations, artifacts and general campaigns survive.
- **Documents:** real CBS, experienced two-page CBS, cover-letter and RenderCV PDFs exercise
  exact-byte text/contact/layout checks. Current renderer/verifier configuration is required
  for review, approval and transmission. RenderCV mapping bytes, size, source and configuration
  are retained and checked. The calibrated CBS footer exception accepts only the shipped page
  counter at its expected position. Missing tools, corrupt/missing text or stale evidence hold.
- **Factual integrity:** source-bound proposals and independent review remain mandatory.
  YAML imports preserve protected identities, dates, degrees and metrics; structural changes
  cannot replace the base resume or bypass review. New batch answers cannot silently become
  accepted resume facts. Rejected or unsupported changes do not become upload-ready documents.
- **Discovery/ranking/batches:** normalized leads remain unverified until authorized official
  source resolution. Source failure/blocked/empty/partial outcomes, feed filtering and source
  scope are tested. Whole-term matching retains short technical terms. Eligible low-fit jobs
  remain schedulable. Shared analysis preserves independent member artifacts and restart state.
- **Forms:** native and recognizable Greenhouse multiselect controls use exact complete option
  values, refreshed set readback and final payload checks. Missing/duplicate/extra selections,
  conflicting saved values, ambiguous field identity and unverifiable controls hold. Explicit
  field names are authoritative; label fallback requires a unique control.
- **Runtime:** strict protocol/result scope, bounds, path/symlink/hash rejection, redacted
  diagnostics, secret isolation, deadlines and cancellation are tested. Request-time dependency
  installation, shells, Docker and additional daemon authority are absent.
- **Compatibility/outcomes:** existing plugin, Pilot, Upwork and provider packaging checks pass.
  Follow-up preparation uses confirmed submitted materials and correlated observations; drafts
  do not send messages or close applications.

`integration-campaign.postgres.test.ts` demonstrates official discovery → eligibility/ranking
→ sourced answers → independently reviewed tailoring → real PDF/verifier/page rendering →
dashboard session approval → Chromium fill/upload. It asserts the synthetic employer receives
zero final application posts. External source, provider readiness and model-review responses
use fixtures; private state services, hashing, PDFs and the browser boundary execute.

Separate synthetic browser/transport suites exercise an authorized final POST and correlated
receipt, crash/restart, lost responses, duplicate prevention and durable uncertainty. These
endpoints are local fixtures; no real employer submission occurred.

## Limits and later actions

Optional boards and feeds remain disabled by default. LinkedIn/Indeed/Google parsers were
tested with synthetic responses in the local gate; later bounded live-access probes are
recorded in SOURCE_VALIDATION.md and do not establish continuing availability or full portal
support. Glassdoor and ZipRecruiter remain unavailable. Feed ingestion accepts bounded
supplied snapshots and does not redistribute datasets or assume graduate eligibility.

Browser results establish synthetic boundary behavior, not approval for a real provider or
every portal. Changed broker code invalidates existing provider verification evidence. Unknown
or unsupported controls still require recovery/handoff. No board login, real application,
recruiter send or new paid-provider use occurred. Independent semantic and visual review in
the integrated campaign use explicit synthetic reviewer fixtures; this is not evidence of a
live model's review quality or universal factual/ATS correctness.

Windows compilation passed, but Windows runtime process-tree cancellation was not exercised
on this macOS host. Native AOT/package execution was built for macOS arm64. CI was updated
with frozen Python/Poppler and disposable PostgreSQL/browser checks. The local results above
precede publication; the PR checks report the separate GitHub Actions results.

The private setup/doctor paths that inspect a real account, private deployment migration,
campaign relaunch, source enablement and live-provider verification
remain later actions. [SETUP.md](SETUP.md) documents installation, reapproval and rollback.
Rollback must stop private live execution and preserve approvals, attempts and reservations.
Stagehand remains deferred, with no production dependency or activation.
