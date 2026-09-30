# Private recruiting integration

Approved September 30, 2026. Baseline: 2155f5266b71b16f3b18460f35a31b44efd68508.
Fork: https://github.com/eugeneaayush/jobpilot. Only this repository is writable;
adjacent reference repositories remain read-only.

## Decisions

- Extend the private /personal workflow first; preserve the interactive Claude/Codex plugin.
- Fit is ranking only. Eligibility remains a separate source-grounded decision.
- Every live application requires dashboard approval of its exact job, answers, documents,
  source facts, requirements, destination and campaign run. Approval also covers live field
  entry and uploads, which can transmit data before final submission.
- Keep the existing CBS renderer as default; RenderCV is optional.
- Keep the existing independent claim and rendered-page reviewers.
- Keep Playwright and the existing broker primary. Stagehand is deferred research, disabled
  and absent from production dependencies. browser-use and invisible_playwright_mcp are excluded.
- Keep Python in one API-owned, bounded local subprocess package. No HTTP daemon, agent MCP,
  database access, browser authority, paid fallback or cloud dependency is added.
- Preserve immutable evidence, caps, claim/lease fencing, cancellation and uncertain outcomes.
- Development uses synthetic applicants and employer fixtures; no live submissions, outreach,
  board login, private database migration or new paid-provider use.

## Corrections to the original kickoff

The fork already implements private discovery, source registries, deterministic evaluation,
answer provenance, independent claim/PDF review, immutable PDF/DOCX, controlled browser and
official-email submission, recovery and a persistent campaign scheduler. The legacy plugin is
a separate runtime. Its full-content variant routes do not run tailoring guards; cover letters
have separate APIs, and legacy campaign/send policy is more permissive than the private plan.
Private generated documents must remain in the stronger private evidence pipeline.

The cloned JobSpy MCP wrapper shells out to Docker with concatenated arguments; do not use it.
Some JobSpy transports use TLS impersonation/proxy rotation and must be removed. Resume-Matcher
is now an LLM-assisted full application, not an independent deterministic scorer. RenderCV 2.8
uses Typst/Python 3.12, not LaTeX, and the local checkout lacks an initialized runtime submodule.
The reference PDF verifiers need additional checks and template calibration. Batch tailoring
is guidance, not an executable library. No AIHawk answer-bank repository exists. Simplify feeds
contain JSON and HTML tables with historical/inactive rows and no tracked license.

See [COMPONENTS.md](COMPONENTS.md) for exact source pins and
[SKILL_API_INVENTORY.md](SKILL_API_INVENTORY.md) for the surveyed API map.

## Authoritative flow

Optional leads -> official posting resolution/source authorization -> eligibility -> ranking
and gap evidence -> proposal -> independent claim review -> render -> deterministic document
checks -> independent visual review -> exact user approval -> broker fill/upload -> one-use
submit authority -> confirmed receipt or durable uncertainty -> tracking/follow-up drafts.

The API owns state. Models propose; utilities compute. Neither may approve or submit.

## Application approval

Expose GET/POST /api/personal/approvals/records/:id and
POST /api/personal/approvals/:approvalId/withdraw. A review packet includes the exact employer,
requisition, destination, posting/facts/settings hashes, campaign run, answer citations,
requirements, final document hashes/reviews and applicable official-email payload.

Grants validate the dashboard session cookie directly, reject bearer authentication, check
the configured UI Origin and a session-bound CSRF nonce, and check private-account ownership.
An actor string or worker PAT is not human approval. The grant is not an agent tool.

Store typed append-only approval history in PersonalRecord.details and copy the receipt into
the immutable attempt manifest. Bind one approval to one attempt using the existing user
transaction lock and record-version checks. Do not hold worker leases during human review.
Expiry is the earlier of 24 hours and the next policy-day boundary. Recheck at start/recovery,
before every live fill/upload/transport and before final submit. Changed inputs/requirements,
new answers, regenerated artifacts or campaign runs invalidate approval. Withdrawal fences
pre-submit work; it cannot retract transmitted data. Possible submissions remain reserved.
The existing default limits remain 50 applications per policy day in America/New_York and
three active applications per canonical employer, subject to stricter configured limits.
Approval never overrides eligibility, source scope, caps, or provider restrictions.

The require_personal_application_approval data migration disables old live private campaigns,
clears old launch authority and requires relaunch. It preserves attempts, reservations, source
artifacts and general-plugin campaigns. No new Prisma tables or columns are required.

## Local Python operations

services/local-tools uses Python 3.12, uv.lock and pytest. The local API executes a fixed module
with one strict JSON request on stdin and response on stdout: protocolVersion, requestId,
operation, payload/result or typed error. Shared Zod contracts and Python validation use common
fixtures. Operations: capabilities, discover_jobs, render_resume, verify_document,
export_resume_yaml and import_resume_yaml. There is no scoring or browser operation.

Use private per-operation directories, fixed executable/operation allowlists, bounded output,
redacted diagnostics, cancellation/process cleanup and API validation of returned paths,
bytes, hashes and schemas. Never inherit runtime credentials or install during a request.
Discovery/render/verification timeouts start at 120/90/30 seconds and remain subordinate to
preparation deadlines. Doctor/setup manage the optional environment; no fifth daemon is added.

## Discovery and fit

JobSpy/feed results enter a shared unverified lead boundary patterned after Brave candidates.
Preserve source, original/direct URLs, row and snapshot hashes, dates, title/company hints and
resolution state in existing discovery-run JSON/private artifacts. Private paginated routes
under /api/personal/leads list, import and resolve them. Promotion requires a supported full
official posting, verified employer/requisition, registered campaign-authorized primary source,
deduplication and existing freshness/eligibility checks. Leads confer no execution authority.

JobSpy initially supports ordinary HTTP LinkedIn/Indeed/Google, serially, at most 20 results
per query and no automatic detail crawl. Boards default disabled. 403/429 returns blocked and
cooldown evidence; partial success survives. No TLS impersonation, proxies, device simulation,
Docker, shell execution, registration or evasion. Glassdoor/ZipRecruiter remain unsupported.

Write independent feed JSON/HTML parsers. Respect active/visible/closed flags, season/dates,
continuation company cells, multiple tables and ATS identity query parameters. Both feeds
default off. No assumed graduate eligibility, copied datasets/updater code or priority boost.

Private scoring retains its formula and deadline/category/fit ordering. Match whole terms in
actual source resume content, including PE/VC/AI/C++/C#. Persist version/input hashes and gaps:
supported and retained, supported but omitted, absent from base, or insufficient evidence.
Never apply fitThreshold as a scheduling gate or present an ATS acceptance probability.

## Documents and batch preparation

Render only accepted evidence/reviewed proposals. Renderer dispatch stays beneath the current
document entry point and immutable publication helpers. Existing CBS remains default; RenderCV
is resume-only. Cover letters use existing attachment APIs. Preserve page budgets.

RenderCV mapping preserves IDs, original dates, contacts, authors, DOI and URL, education,
certifications and custom sections. Never infer Present, split ambiguous names/degrees or load
arbitrary themes/resources. Generic entries handle source shapes that specialized entries
cannot faithfully represent. A JobPilot-produced YAML+mapping bundle is the supported round
trip. Import proposes guarded reorder/cut/rephrase operations; it cannot replace base facts.

Bind renderer/package/template/config/verifier versions into preparation hashes. Regenerate
only affected stages on change. Add exact-byte text/contact/glyph/keyword/page/layout checks
before independent visual review, including cover letters and reused artifacts. Unavailable
tools or failed checks hold readiness. Repairs return through factual review and new hashes.

Batch 3-5 jobs with the same frozen evidence and recruiting track. Auto-suggest only with at
least 60% overlap of normalized posting-supported campaign terms. Store one immutable shared
gap artifact and deduplicate factual questions; keep independent proposals, reviews, artifacts,
approvals and outcomes. Resume partial batches without duplicates. New facts require explicit
source acceptance and refreshed evidence before use.

## Screening, broker and outcomes

Extend existing sourced answer settings/snapshots; keep sponsorship, country authorization,
skill-specific experience, salary currency/period, relocation, availability and voluntary EEO
distinct. Models classify fields, never invent values. Port narrow label/ARIA/control/section
heuristics, verify refreshed readback, exact choices, complete multiselect and date precision.
Unknown requirements, conflicts and consent use existing handoff/recovery. Broker edits require
fresh synthetic metadata-boundary verification; they never self-grant real-provider approval.

Follow-up drafts use confirmed submitted materials, begin after ten quiet days and stop at two
drafts per application. Drafted/sent/confirmed/uncertain remain distinct. No sends or auto-close.

Stagehand's deferred fixture benchmark must prove same-session handoff, exclusive ownership,
state preservation, approved inference/data boundaries, zero submits and a measurable recovery
improvement before any later production decision.

## Milestones and validation

The implementation checklist below distinguishes code present in this checkout from final
verification and deployment. Exact executed results belong in [VALIDATION.md](VALIDATION.md);
the checklist is not a release or authorization to run live campaigns.

| Order | Deliverable present in the checkout | Completion boundary |
| --- | --- | --- |
| 0 | Audit plan, complete skill/API inventory, source pins, provenance, setup and checklist. | Baseline checks recorded; final validation report remains the evidence authority. |
| 1 | Session-only exact-packet review/approval/withdrawal, attempt binding, transmission fencing and campaign data migration. | Final regression gate covers browser, email, handoff, races, expiry, withdrawal and uncertain receipts. Migration is not applied to a private runtime during development. |
| 2 | Whole-term private ranking and source-bound fit/gap evidence. | Regression gate proves low-fit eligible jobs remain schedulable. |
| 3 | Locked Python package, fixed subprocess protocol, capability diagnostics, setup and CI. | Protocol, cancellation, bounded paths/output and secret-isolation checks pass. |
| 4 | Shared lead storage/resolution and restricted JobSpy parsers/adapters. | Synthetic source outcomes and authorized official-posting promotion pass. Optional boards remain off by default. |
| 5 | Optional RenderCV, fixed resource configuration and guarded JobPilot YAML bundles. | Supported mappings/round trips, prohibited changes and renderer/configuration hashes pass. CBS remains default. |
| 6 | Exact-byte document verification for resumes and cover letters before independent visual review. | Missing, failed, stale or unavailable verification holds readiness; both renderer fixtures pass current checks. |
| 7 | Immutable shared analysis for 3–5 related roles, one source question and independent resumable member preparation. | Restart, isolated failure and changed-evidence checks pass; questions never silently add facts. |
| 8 | Sourced screening defaults and conservative verified control handling. | Synthetic field/readback and broker boundary tests pass. Real-provider approval is a separate existing gate. |
| 9 | Independent supplied-snapshot JSON/HTML feed ingestion. | Inactive, season, freshness, continuation-row and ATS-link tests pass. Feeds remain off by default. |
| 10 | Draft-only follow-ups and synthetic integrated campaign/transport coverage. | Final evidence report and full verification gates complete. No real employer transmission is part of this development milestone. |
| Deferred | Stagehand benchmark specification only. | Separate fixture evaluation and go/no-go report before any production decision; no core dependency or activation. |

- [x] Implement the core milestone surfaces without parallel state stores or scoring engines.
- [x] Add focused protocol, factual-integrity, source, document, approval and browser regressions.
- [x] Finish and record all applicable repository gates in VALIDATION.md.
- [x] Commit the reviewed integration using repository conventions after the gates pass.
- [ ] Apply the campaign data migration and relaunch private live campaigns only as a later authorized deployment action.

Each change needs focused regression tests, docs/changelog, compatible provider assets and
the repository verify gate before commit. Branches use codex/integrate-<slug>; do not push or
open PRs without authorization. Disable affected optional sources/renderers or stop private
campaigns before rollback. Preserve migrations and evidence; reverting approvals leaves live
execution stopped.

Required tests cover session/PAT/CSRF boundaries; stale/expired/withdrawn packets; concurrent
approval binding; fake employers/metrics/titles/degrees/technology/dates; source partial failures,
blocked access, stale/missing postings and scope; low-fit eligibility; lossless mappings and
Unicode; missing text/contact/glyphs, stale hashes and layout; batch restart/source changes;
ambiguous labels/options/polarity/date/salary precision; subprocess timeouts/path escape/secrets;
caps, leases, stop/restart, duplicate submit, uncertain receipt and reconciliation; legacy plugin,
Upwork, provider packaging and Pilot compatibility.

Final gates: Biome CI, knip, API/web/contracts/personal typechecks, API/contracts tests, pytest,
disposable PostgreSQL race tests, isolated synthetic browser suites, relevant builds, and .NET
tests/package checks when touched. Record actual results separately from historical counts.

Done means a synthetic campaign completes discovery, resolution, ranking, guarded tailoring,
verification, exact approval and fill, stopping before real submit; separate synthetic transport
tests prove submit/receipt/crash recovery. All new live paths require approval, unsupported facts
are held, low fit never rejects eligibility, both renderers retain evidence, docs explain setup,
licenses/interfaces/migrations/rollback, and the report names unsupported/deferred capabilities.
