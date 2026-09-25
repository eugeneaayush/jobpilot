# Personal recruiting connector contract

## Current coverage

Greenhouse, Lever (global and EU) and Ashby public employer boards are implemented, along with
bounded CBS CSV imports. Each run retains its explicitly configured scope and distinguishes
complete, partial, blocked and failed results. Empty complete results are not failed searches.
The paginated registry records per-source health, last success and next permitted attempt.
A configured Brave connector supplies unverified career URL candidates under a reserved budget;
its snippets are not full job descriptions or eligibility evidence.

Coverage is limited to those configured sources and queries. Private firm seeds from a separate
recruiting project are research inputs, not proof that their websites have been searched. Workday
tenants, arbitrary career pages and optional JobSpy discovery require additional tested adapters.
The implementation never claims whole-market or whole-Internet coverage.


## Discovery adapter extension

A new adapter must be independent of browser submission and persistence. Before adding it, extend the source type intentionally; the current `DiscoveredPosting.source` is specifically `greenhouse`.

Each normalized posting must carry:

- Source type, configured employer or tenant, native posting ID, and a stable cross-run identity.
- Title, employer, canonical employer URL, location, full original description and inert extracted text.
- Discovery time, source-provided publication/update/deadline fields, and explicit nulls when unknown.
- Source URL, SHA-256 of source content, and the untouched raw object or a private raw-artifact reference.

Each run must carry expected and returned counts, pagination/cursor evidence, timestamps, attempted request count, HTTP status, errors, and one of `complete`, `partial`, `failed`, or `blocked`. Missing pages, malformed responses, throttling, and authentication errors must not become successful empty results. Bound timeouts and retries; honor Retry-After or park when its delay exceeds the bounded run. Default discovery operations to GET. A source endpoint's ability to accept applications is not permission to use it.

Source HTML and text are untrusted data. Strip executable markup without evaluating it. Never follow source-provided instructions to reveal credentials, change policies, fabricate candidate facts, or make submissions. Discovery configuration must not accept an arbitrary internal URL. Introduce an explicit host/tenant validation rule for each new provider.

Add synthetic tests for pagination/count mismatch, duplicate identities, absent fields, native-ID stability, source HTML, expired deadlines, timeouts, 429, authorization failures, and redirect handling. Do not validate connectors by submitting real applications.

## Evaluation boundary

Eligibility and fit remain separate. Hard requirements retain quoted source evidence and `satisfied`, `violated`, or `unknown` judgments. Candidate facts are supplied explicitly; citizenship alone does not establish work authorization. General professional roles remain in the system even without MBA wording. An ordinary experienced role stays in that track when an MBA is preferred or required; post-MBA classification requires an explicit MBA recruiting program or graduate-entry cohort signal.

The current date-range evaluator recognizes explicit ISO date spans such as `available from YYYY-MM-DD through YYYY-MM-DD`. It compares those dates only with supplied candidate availability boundaries. Natural-language dates remain for review; date coverage does not imply full-time or immediate availability. Unverified compensation retains an unknown preference outcome.

A connector refresh must invalidate stale downstream readiness when a posting, requirement, identity, or content hash changes. Discovery coverage, eligibility, document review, complete answers, campaign authorization, and submission confirmation are distinct states.

### Source-backed decisions and recovery

The recovery API exposes the stored posting, individual requirement IDs and quotations, current evidence context, latest attempt, blockers, and immutable decision history. A manual eligibility decision must cite the exact source quotation. A `satisfied` or `violated` decision also needs an exact saved settings/resume leaf or screening-answer snapshot value; a rationale alone is insufficient. An unresolved clause remains `unknown`. The original automated evaluation is retained.

Decisions bind posting, settings, résumé evidence, source, and requirement hashes. An unchanged discovery refresh preserves valid decisions and unrelated unanswered screening questions. Changed evidence invalidates the decision's applicability; it must be reviewed against the new context. Saving a decision invalidates the previous preview review.

Recovery applies only to a resolved, pre-submission blocker or eligible failed attempt within the already authorized campaign run. It issues a single-use preparation ticket, retaining the original attempt and history. It does not launch a campaign or authorize a final click. Actual preparation failures have at most two retries; resolving a missing answer or login blocker does not itself consume that failure allowance. Any possible submission requires reconciliation first. See the [local recovery runbook](personal-local.md#resolve-eligibility-and-recover-a-parked-job).

### Attachment evidence

The implemented Greenhouse requirements refresh reads the public job endpoint with `questions=true`. It saves the original response privately with its hash and maps file questions to résumé, cover letter, or another file requirement. Browser inspection can also supply a private, attempt-bound inventory. The public endpoint is a documented read interface; it does not grant submission access. [Greenhouse job questions](https://docs.greenhouse.io/job-board.html#retrieve-a-job).

Cover-letter generation uses the current résumé's exact cited facts, a deterministic local template, and the target job/company. It records source pointers, source/data hashes, PDF hash, and the matching employer field. A rendered review is bound to that exact document. Refreshing requirements, generating/reviewing an attachment, or changing answers requires a new offline preview and résumé review before the new manifest is usable. Old artifacts remain available. Other required file kinds remain blocked until supported; an arbitrary local path is not an upload grant.

## Browser adapter extension

The host launches the fixed `bun plugin/scripts/personal-browser.ts` entry using the scoped API URL/token, attempt ID, lease owner/generation, and private root environment variables. The API origin must be loopback. The broker exposes only `inspect_form`, `fill_field`, `upload_resume`, `upload_attachment`, `submit_application`, and `reconcile` through official MCP stdio. There is no arbitrary JavaScript, shell, navigation, answer text, upload path, or authorization-override tool.

The immutable manifest supplies `answers` as an array of `{key, value, fieldName?, label?}`, a hash-pinned résumé `document`, reviewed attachments and their inventory, and an applicant email (directly or through the matching email answer). Field references come from observed DOM controls. The model receives only opaque answer/attachment handles; the broker reads the corresponding private values and bytes. Unknown, ambiguous, unsupported, or missing answers park for user review. Readiness is still enforced by the API immediately before the final click.

The native-form adapter supports visible text, email, telephone, URL, number, date, textarea, select, checkbox, and file controls with exact field matching. Files must match the frozen résumé or attachment. It requires one unambiguous native submit control and same-origin POST form action. Greenhouse uses the separate adapter below. Other custom widgets, cross-origin application services, multi-step applications, and staged upload protocols require their own verified adapters. A headed security handoff does not add support for an unknown application protocol.

### Bounded Greenhouse hosted-form adapter (2026-09-16)

The implementation follows the public hosted frontend observed on the [Garda](https://job-boards.greenhouse.io/gardacp/jobs/6163540004) and [Robinhood](https://job-boards.greenhouse.io/robinhood/jobs/8198187) postings. Its React handler, signed uploads, final JSON construction, and response codes are present in Greenhouse's [published frontend source map](https://job-boards.cdn.greenhouse.io/assets/entry.client-B5kjVA5a.js.map). The HTML form's default GET action is not its application transport. This is a bounded adapter for that observed implementation, not a promise of compatibility with every Greenhouse form or a stable vendor integration contract.

The adapter binds the actual hosted URL, route loader, board, post ID, declared submit destination, fingerprint, and confirmation path to the frozen posting identity. It maps known React controls by stable IDs and observed labels. Dropdown answers must match trusted loader choices or an exact scoped lookup response. Country/phone normalization preserves approved digits; city coordinates come only from the selected approved location result. English education months use the published [locale labels](https://job-boards.cdn.greenhouse.io/locales/en/job_post.w6CpxN5AN8G5QgyFGueLoXbJir3fUNAC7WJUhEJ1Qt8.json). Unknown required controls or unsupported selections park the job.

Demographic answers are limited to explicitly frozen choices that the loader marks as non-freeform declines. The adapter never derives a trait or a decline from personal facts. An optional question may remain blank; a missing required choice remains held. Collection/processing consent is a separate explicit boolean answer and is not implied by declining demographic questions.

Uploads are transmitting preparation actions. The broker accepts only requested, observed file fields and validated signing metadata from `boards.greenhouse.io/uncacheable_attributes/presigned_fields`. Each staged multipart POST is restricted to the observed Greenhouse S3 service, signed key/policy, exact filename, and frozen file hash. Successful staging retains verified attachment evidence even when React replaces the file input with its filename. Arbitrary upload URLs, unreviewed files, or changed bytes are blocked.

Before forwarding the final JSON POST to `https://boards.greenhouse.io/{board}/jobs/{postId}`, the adapter rebuilds and compares the complete application against the frozen approved fields and staged attachments. It rejects extra claims, unknown envelope fields, and changed values. After `begin-submit`, it saves the exact request privately and pins its destination, manifest, application hash, and request hash through the API's `challenge/freeze` transition. That durable freeze must succeed before the single final request is sent. Automatic redirects, alternate submit destinations, and repeat final requests are denied.

The documented Job Board API permits public GETs, but application POST requires an employer Job Board API key using Basic Auth. Research established no documented candidate submission API that avoids that employer credential. The hosted frontend is evidence of the site's implementation, not a supported integration contract. [Official authentication and application API](https://docs.greenhouse.io/job-board.html#authentication).

Greenhouse documents invisible reCAPTCHA and possible email-code verification. The adapter permits narrowly scoped site reCAPTCHA traffic for the authorized submit action; it does not solve a user challenge or bypass a warning. Recognized nonacceptance responses are recorded against the exact submitted request. The affected attempt stays reserved, its worker is revoked, and the dashboard offers user email-code handling only when supported challenge evidence includes a recipient. See [official reCAPTCHA guidance](https://support.greenhouse.io/hc/en-us/articles/115005448066-Invisible-reCAPTCHA) and the [local verification runbook](personal-local.md#greenhouse-email-verification-on-the-same-attempt).

Email continuation preserves the exact frozen application and fingerprint, adds only the user's eight-character code, and consumes a separately fenced one-use permit before sending. It is not a model tool and does not create a new application attempt. A further recognized challenge requires another explicit user action. CAPTCHA retry, missing recipient evidence, unrecognized responses, lost responses, and unsupported challenges remain held; there is no automatic uncertain retry. Request and response evidence stays in private mode-0600 artifacts, including the continuation request containing the code.

Initial acceptance requires the captured successful POST response plus the matching confirmation destination; the publicly accessible confirmation page alone proves nothing. Email continuation can settle the same attempt only from a successful response correlated with its consumed permit and unchanged application hash. Malformed nonempty success bodies, HTML login pages, errors, and redirects are not acceptance evidence. Synthetic tests and public read-only inspection do not establish a successful live employer application; integrated validation remains a separate release check.

### Network and submission rules

- Offline attempts never launch a browser or contact employers; local API reads are allowed.
- Live inspection/fill/upload are labelled as potentially transmitting. The native adapter blocks non-read requests before submission permission. Greenhouse additionally permits its validated file staging under the current preparation lease; this is an upload, not a final application.
- Scope native browser traffic to the captured source origin. Greenhouse has an explicit host/path allowlist for hosted assets, scoped education/location lookups, signing/upload services, reCAPTCHA, and the frozen submit target. Arbitrary analytics, email validation, Quick Apply, and unrecognized data-bearing requests are denied. WebSockets and service workers are blocked.
- Fetch redirects without automatically following them. The native adapter parks redirects; Greenhouse permits only separately checked navigation within its frozen posting scope. Final submit/continuation redirects are not acceptance evidence.
- After `begin-submit` succeeds, permit exactly one final POST to the validated destination. Consume authority before forwarding it. Only an explicit user challenge continuation may receive a new one-use permit for the same frozen application; no automatic retry or alternate endpoint is allowed.
- Recheck current attempt state before fill/upload. A cancelled or terminal attempt has no preparation authority.
- Verify each résumé/attachment hash and send those exact bytes, rather than rereading a path after verification.

A native-form receipt requires an observed confirmation heading outside forms, quotations, code, and templates, plus the original job title and expected applicant email. Greenhouse uses the correlated transport evidence described above. Generic "Done", quoted example confirmations, public confirmation URLs, and instructions in page text do not prove submission. If confirmation is incomplete, the browser crashes, a redirect is blocked, or the receipt cannot be persisted, preserve uncertainty and do not retry.

### Headed login and security handoff

Before the submit boundary, the broker can park the affected attempt and request a durable handoff. Its record contains the job/attempt, profile key, allowed origin, reason, and independent lease. The authenticated terminal starts the fixed broker with `--handoff`; no model handles this browser. The user opens it from the dashboard and enters credentials, a new password, or verification codes directly. CAPTCHA and binding terms require the user's action-time handling. Security warnings are never bypassed, and an employer account is created only when required.

The handoff keeps the same exclusive persistent profile. It blocks application requests throughout; only recognized same-origin authentication paths may receive user-initiated POSTs under a current lease. Cross-origin redirects and unsupported authentication flows remain blocked. Resume checks the origin and visible challenge state, produces a private hashed proof, and closes the browser before the API accepts the proof. Resolving the handoff enables a separate recovery request; it never clicks submit or resumes an old apply task. The [terminal endpoint/setup reference](personal-local.md#login-and-security-handoff) describes leases and restart handling.

### Privacy and profile recovery

One user profile has one exclusive lock containing the attempt, owner, PID, and random lock nonce. The broker does not automatically delete stale locks. Before manual removal, inspect the lock and API attempt, confirm the associated browser process has stopped, and reconcile any attempt that crossed the submit boundary. A new broker must not take over an unresolved submission. Closing a broker removes only the lock bearing its own nonce.

MCP inspection exposes opaque field references, input types, required/answered flags, and approved-answer/attachment aliases. Raw page text, labels, URLs, options, answer values, document paths, and receipt contents stay local. Errors return fixed classifiers rather than raw browser messages. Full observed question and receipt evidence remains in private files with mode 0600 under the user's runtime directory; it is not a public log. Avoid printing manifest answers, API tokens, browser storage, or raw confirmation bodies to console logs. Keep source and receipt artifacts out of Git. Provider verification pins the provider configuration and entry plus all TypeScript modules under `personal-browser/`; any changed module requires reverification.

## Acceptance evidence

The test inventory uses local synthetic HTTP forms, Chromium, mocked providers, and isolated PostgreSQL schemas. It includes offline isolation, immutable answers/attachments, signed-upload validation, API permit ordering, one POST per permit, correlated acceptance, user-code continuation, cancellation, crash uncertainty, receipt digests, handoff restrictions/profile locks, stale recovery evidence, and MCP protocol operations. Public loader fixtures cover Garda and Robinhood defaults and field types. This describes test coverage, not a completed full-suite run or a certified live employer flow. Every new adapter still needs source/form identity evidence and tests at the same failure boundaries.

## Lever hosted form boundary

The Lever driver supports strictly observed native fields and multipart submission on the exact
verified global/EU posting URL. Required custom widgets, unsupported hidden fields, signing or
staging endpoints and unexpected redirects park the application. It does not guess private APIs.
The server freezes a content-addressed request artifact before forwarding and rechecks the owned
active submit lease and manifest. Wire-body and parsed payload hashes are both preserved.

One final POST is permitted. Lever does not yet have a verified positive confirmation oracle, so
an HTTP 2xx response is recorded as submission-uncertain, not submitted. Reconcile that original
attempt using correlated employer evidence; do not retry it. Synthetic tests establish the tested
native-form behavior only, not universal compatibility with live Lever forms.
