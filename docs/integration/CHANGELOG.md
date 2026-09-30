# Integration changelog

## September 30, 2026 — private recruiting integration

Baseline: `2155f5266b71b16f3b18460f35a31b44efd68508` in
[eugeneaayush/jobpilot](https://github.com/eugeneaayush/jobpilot). This entry records
implemented behavior, not a deployment or release. Executed checks, counts and
remaining validation limits belong in [VALIDATION.md](VALIDATION.md).

The implementation is published in [PR #1](https://github.com/eugeneaayush/jobpilot/pull/1).
Follow-up preparation adds [PRIVATE_ROLLOUT.md](PRIVATE_ROLLOUT.md) with installation,
migration preservation and exact reapproval checks, without applying a private migration.
[SOURCE_VALIDATION.md](SOURCE_VALIDATION.md) records one ordinary-HTTP probe per board:
five unresolved LinkedIn leads, blocked Indeed/Google outcomes and unchanged source
defaults. Audited feed READMEs parse within bounds; whole JSON snapshots exceed the
current limits and require bounded private subsets.

- Added dashboard-only exact application review, expiring single-attempt approval,
  withdrawal, and approval checks before live filling, uploading and submission.
  The data migration pauses existing live private campaigns and clears their launch
  authorization; attempts, reservations and general-plugin policy are preserved.
- Kept the existing deterministic fit formula and queue priority. Whole-term evidence
  now records frozen posting/base/campaign hashes and distinguishes supported,
  omitted, absent and unavailable terms. Fit never rejects an eligible private job.
- Added one locked Python 3.12 package with validated bounded subprocess operations,
  sanitized child environments, cancellation, artifact checks, setup and diagnostics.
  CI installs the frozen environment and Poppler and runs its tests.
- Added paginated unverified leads, immutable source snapshots, deduplication,
  optional LinkedIn/Indeed/Google queries and existing Brave candidate ingestion.
  Resolution requires registered, employer-verified, campaign-authorized official
  discovery with a full posting. Sources cannot authorize their own applications.
- Added independently written JSON/README HTML feed parsing, date/season filtering,
  active/visible/closed checks and direct ATS link handling. Feeds and optional
  boards remain disabled until explicitly configured; no datasets are redistributed.
- Added optional RenderCV Classic beneath existing private document generation;
  CBS remains default. Controlled YAML bundle imports propose supported cuts,
  ordering and grounded bullet rewrites without modifying accepted source facts.
- Added exact-PDF text, contact, glyph, selected-term, page and calibrated layout
  verification for resumes and cover letters before visual review. Failed or
  unavailable checks hold readiness, including reused artifacts.
- Added immutable shared gap analysis for 3–5 related roles, one existing Pilot
  source question, and resumable individual preparation checkpoints. Answers do not
  become resume facts without separate explicit source acceptance and regeneration.
- Added sourced screening suggestions and conservative form audits: refreshed field
  identity/value readback, exact select membership, date precision and preservation
  of conflicting values. Native multiselect and recognizable Greenhouse ReactSelect
  controls use complete approved option-value arrays, refreshed selection readback
  and exact final payload audits. Unknown required controls, partial selections,
  ambiguous choices, unverifiable controls and consent remain handoffs.
- Added follow-up drafts from confirmed submitted materials after ten quiet days,
  limited to two. Observation routes require existing correlated delivery/reply
  evidence; creating a draft never sends or closes an application.
- Added synthetic campaign, PostgreSQL race, protocol, document, browser and dashboard
  regression coverage. Development does not grant real-provider verification or
  establish live job-board availability.

Reference decisions and retained material are recorded in
[COMPONENTS.md](COMPONENTS.md). The verifier, batch workflow and control heuristics
are original implementations informed by the audit; no ai-job-search,
resume-tailoring-skill or OpenJobAutofill source is copied. Stagehand remains a
separate deferred evaluation, with no production dependency or activation.
