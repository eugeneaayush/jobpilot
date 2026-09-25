# Private local JobPilot

This slice reuses JobPilot's Next dashboard, authenticated Elysia API, PostgreSQL/Prisma models, résumé model/tailoring, and .NET terminal. It adds an isolated personal dashboard at **http://localhost:4100/personal**. No public deployment is required.

## Run

From the repository root:

```sh
bun install
bun run personal:doctor
bun run personal:setup
bun run personal:dev
```

In another terminal:

```sh
bun run personal:preview
```

`doctor` reports installed versions, missing sources/browser setup, and live-execution holds. `setup` provisions a separate PostgreSQL 17 cluster, installs .NET 10 from its official distribution when missing, generates Prisma, applies migrations, seeds job-board metadata, and creates a localhost-only account. On Apple Silicon, PostgreSQL comes from Homebrew. Other hosts can set `JOBPILOT_POSTGRES_BIN` and `JOBPILOT_DOTNET` to installed executables. Local browser execution and fixtures require `bunx playwright install chromium`; a headed handoff also needs an interactive desktop session.

`dev` starts the API on **127.0.0.1:4101**, web on **127.0.0.1:4100**, terminal on **127.0.0.1:4102**, and a passive campaign scheduler. Ctrl-C stops these processes; PostgreSQL remains running so its journal is durable. The private database listens only on **127.0.0.1:5433** by default (`JOBPILOT_POSTGRES_PORT` on initial setup).

Runtime root: `~/Library/Application Support/JobPilotPersonal` (directory mode 0700). Set `JOBPILOT_PERSONAL_ROOT` consistently to relocate it. `runtime.json` (mode 0600) holds local login credentials, database credentials, API token, selected source paths, and provider approvals. Use the local email/password from that file to sign into the dashboard. Do not copy this file into the repository or a public deployment.

`preview` imports the configured MBB JSON/DOCX, runs one public Greenhouse employer feed, evaluates its postings, and prepares an **offline** preview. Source reads are separate discovery activity; preparing/viewing an offline application makes no employer form request, upload, or submission. The authenticated offline form has no submit action. With no résumé assets on a fresh setup, explicitly synthetic sources are created in private storage and held from live submission.

## Current execution boundary

- Default: stopped campaigns, unknown screening answers, no recruiter sends.
- Greenhouse, Lever, and Ashby public-board discovery plus CBS CSV imports are implemented. A `complete` run covers that named board's or import's API response, not all jobs on the internet. Empty, partial, failed, and blocked runs differ. Discovery support is separate from live submission support, which remains bounded per board below. See [connector coverage](personal-connectors.md).
- Résumé source files are preserved byte-for-byte. Imports retain copies, SHA256 values, JSON pointers, DOCX paragraph references, and conflicts. Tailoring reorders supported bullets, and after independent grounded claim review it may apply fact-cited paraphrases (`reviewed_rewrite` mode); stale facts, changed metrics, and unsupported claims stay held, and original sources are never rewritten. PDFs use education-first Letter pages and a readable serif font. Conflicted documents display **DRAFT** and stay drafts after visual inspection.
- The dashboard exposes separate eligibility and fit, source receipts, document hashes, preview readiness, campaign controls, and recent attempt history. Public portfolio/activity/leaderboard/résumé routes and job publication are disabled in personal mode.
- Personal routes require the single account ID in private runtime configuration, in addition to valid authentication. Other authenticated accounts cannot import configured sources or read candidate defaults. Password/OAuth signup is disabled in personal mode; `personal:setup` provisions the account directly.
- Offline campaigns use the mock supervisor and worker. Real Codex supervision uses the installed, version-checked app-server interface with empty environments, disabled inherited MCP/tools/plugins/hooks, bounded public job inputs, and structured proposals. The host validates proposals before dispatch. Unsupported CLI versions remain blocked until verified.
- The Claude adapter exposes only inspect/fill/verified-upload/submit/reconcile through the local browser broker. In metadata-only scope, the model sees opaque field references, exact approved-answer keys, action status, and receipt hashes. Applicant values, raw page content, documents, and receipts remain in private local storage. The broker supplies approved values directly to the authorized form. Missing fields or security challenges park that application.
- A dedicated Greenhouse hosted-form adapter maps known React controls, validates signed attachment staging, and freezes the complete approved JSON request before its single final POST. Supported post-submit email verification uses a separate user action on the same attempt. Unknown required fields, unsupported challenges, and ambiguous outcomes remain held. Implementation coverage is not evidence of a successful live employer application.
- Provider approval is private and scoped. Both scopes require explicit verification; metadata-only scope also pins the reviewed provider configuration and broker implementation hashes. A changed configuration/broker must be reverified. No provider or model is silently changed. PHI-adjacent material must not be sent to unverified foreign-hosted providers. Live readiness reports the actual setup state; it does not claim every employer form is supported.
- The authenticated readiness panel distinguishes setup blockers from per-job questions. Screening answers require explicit confirmation or an exact cited source leaf. Saving answers appends an immutable snapshot, invalidates the preview review, and never silently clears eligibility or factual holds. Regenerated manifests freeze both values and citations.
- A source-hash-pinned resolution overlay may correct or omit supported facts in a derived resume. Original JSON/DOCX and all original comparisons remain immutable. Audited editorial classifications carry citations; unresolved employment history and metrics remain visible. Every new PDF requires a separate rendered inspection.

## Campaign and recovery rules

Create a campaign with named public boards (Greenhouse, Lever, or Ashby), track(s), minimum fit, daily and total caps, timezone, and offline/submit mode. Launch explicitly freezes those settings and résumé evidence. A configured submit launch authorizes ordinary applications in that scope, without another approval for every job. Changing facts/settings requires stopping and relaunching the campaign. Recruiter communication is separate and has no send path in this feature.

Optional role scope adds an internship-only requirement and selected categories: technology product management, MBB consulting, and buy-side investing. Scope is checked using posting evidence at reservation and again before submission; missing evidence parks the job. Selecting both MBA and general tracks includes internships that do not mention an MBA. It does not permit full-time positions when internship-only scope is enabled. Source, track, and role scope are frozen with the attempt. The scheduler may still generate an offline document for a role that the reservation gate rejects.

Work authorization is scoped to explicitly supplied country codes. An unknown or mixed posting location cannot inherit a general authorization answer. Availability notes preserve statements such as part-time now or full-time in a future summer without manufacturing exact dates or sponsorship answers.

Resolving a source conflict records a documented choice or omission; it does not certify employment records independently. The original comparison and all prior artifacts remain available. A current-city confirmation can supersede an earlier omission in a new derived version.

The scheduler checks active campaigns every 15 seconds and refreshes each configured source at most hourly. It persists task IDs before dispatch and handles one reserved application at a time. Its state, worker leases, checkpoints, outputs, and artifacts survive process restarts. UI stop revokes preparation; a possible submission remains uncertain and consumes capacity until evidence resolves it.

Application identity uses user plus employer/requisition and URL aliases. Greenhouse posting IDs are not requisitions: reservations prefer the underlying `internal_job_id`, then `requisition_id`, with a native posting ID only when neither exists. Alternate postings of the same underlying job share the duplicate guard. Historical reservations remain protected. Identity does not expire after an arbitrary number of days. Attempts freeze exact documents and answers. A submit intent is committed before the final browser action. `submitted` requires a hash-verified confirmation artifact. Crashes after a possible click cannot automatically reopen the job. Preview completion is `previewed`, never `submitted`.

Preparation leases expire after 90 seconds with 15-second heartbeats. Tasks have 15-minute deadlines, at most two pre-submission retries, bounded output, graceful cancellation, and process-tree cleanup. See [worker interface](../apps/terminal/Workers/README.md). The main interactive PTY remains available separately.

### Resolve eligibility and recover a parked job

Use the record's **Recovery** view to read its source quotation, requirement IDs, current evidence context, blockers, latest attempt, and prior decisions. For each reviewed requirement, choose `satisfied`, `violated`, or `unknown`. A decided status requires the exact employer quotation, a rationale, and an exact saved fact: a settings/résumé JSON pointer and value, or a screening snapshot hash, key, and value. A plausible inference or a free-text rationale cannot replace the citation. Keep unresolved requirements unknown.

The server checks the record version and hashes of the posting, settings, résumé evidence, and requirements. Decisions are appended without rewriting the automated evaluation or original sources. Routine unchanged discovery preserves valid manual decisions and unrelated missing answers; changed evidence requires review again. Saving a decision invalidates the previous preview.

For a blocked job, resolve the recorded cause first: save an answer snapshot, save an eligibility decision, or finish a browser handoff. Then request recovery with that proof and a reason. A failed preparation may use the bounded failure-retry path. Recovery stays inside the existing campaign authorization, checks its frozen scope, and creates a single-use ticket for fresh preparation. It retains the original attempt and does not submit. Actual failures allow an initial attempt plus two retries; clearing a missing-answer/security blocker does not consume that failure allowance. Stale evidence, an active preparation, or a possible submission blocks recovery. Refresh evidence after a conflict response instead of resending the old body.

All routes below are on the authenticated private API at `http://localhost:4101`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/personal/recovery/records/{recordId}` | Current source, context, decisions, blockers, and retry status |
| POST | `/api/personal/recovery/records/{recordId}/eligibility` | Save source-backed requirement decisions |
| POST | `/api/personal/recovery/records/{recordId}/recover` | Request fresh preparation using resolved-blocker evidence |

Both writes include the GET response's `updatedAt` as `expectedUpdatedAt` and its complete `context`. Eligibility adds `decisions`; recovery adds `attemptId`, `campaignRunId`, `reason`, and a typed `proof`. The precise request schemas live in [personal-recovery.ts](../packages/contracts/src/personal-recovery.ts). These are dashboard/API operations; the CLI has no recovery subcommand.

### Refresh, generate, review, and freeze attachments

1. Open **Attachments** for the job and refresh its requirements. This reads public Greenhouse question metadata and stores a hashed source receipt; it sends no applicant values or files. A browser inspection may also provide requirements. Unknown inventory is different from a verified empty inventory.
2. Generate a cover letter for the saved employer field. Generation uses the current résumé's cited facts and a deterministic local template. It creates a private PDF and records its source/data hashes. Other required attachment kinds remain held until supported.
3. Open and visually inspect the PDF, then save the review for its exact attachment ID and PDF hash. Regeneration creates a new version; an earlier review cannot approve it. Changing facts or employer requirements can require regeneration.
4. Run **Preview** for this record again. It freezes the current questions, answers, résumé, attachment inventory, document hashes, and citations into a new offline manifest. Open the new résumé PDF and save its own rendered review. A cover-letter review alone does not make the preview ready; unresolved facts or missing required files still block it.

Stop active preparation before editing attachments. Changes invalidate the preview review, preserve earlier artifacts, and never rewrite a reserved attempt. Offline preparation/viewing performs no employer upload; refreshing public requirements is a separate GET. Live native-file upload and Greenhouse signed staging use only the manifest's verified bytes. Staging transmits a file to the employer's upload service before final submission.

| Method | API path | Input/purpose |
| --- | --- | --- |
| GET | `/api/personal/attachments/{recordId}` | Inventory, source receipt, versions, reviews, missing files |
| POST | `/api/personal/attachments/{recordId}/requirements/refresh` | Refresh public file questions; no body |
| POST | `/api/personal/attachments/{recordId}/cover-letter` | `{fieldName}` from the saved inventory |
| GET | `/api/personal/attachments/{recordId}/{sha256}/pdf` | Read the owned PDF version |
| POST | `/api/personal/attachments/{recordId}/review` | `{attachmentId, pdfHash, inspected: true, notes?}` |
| POST | `/api/personal/{recordId}/preview` | Freeze a new offline preview; no body |
| POST | `/api/personal/{recordId}/render-review` | `{pdfHash, inspected: true, notes}` after inspecting the new résumé |

See [attachment contracts](../packages/contracts/src/personal-attachments.ts). Public file questions are part of the [official Greenhouse job retrieval API](https://docs.greenhouse.io/job-board.html#retrieve-a-job); their availability does not establish a supported submission flow.

### Login and security handoff

A pre-submission login or security interruption parks only the affected job. The **Security handoff** view shows its reason, allowed employer origin, attempt, and status. Choose **Open** to start a headed local browser using the same persistent user profile and exclusive lock. Enter credentials, any new password, and verification codes directly in that browser. CAPTCHA and binding terms require user action at the time they appear. Never bypass a security warning, and do not create an employer account unless required by the application.

After handling the interruption, choose **Resume**. The broker checks the current origin and visible challenge state, saves a private hashed proof, and closes the browser before the API accepts resolution. A still-visible challenge remains pending. A resolved handoff enables a separate recovery request; it does not resume an old apply task or submit an application. **Cancel** closes the handoff browser and releases its slot. Application requests are blocked throughout the handoff; only recognized same-origin authentication POSTs are permitted under a valid lease. Unsupported authentication redirects remain blocked.

`personal:setup` creates the private broker template; `personal:dev` supplies `JOBPILOT_WORKER_MCP_CONFIG`, the fixed loopback API, and the same private root to the terminal. Do not launch the broker with a caller-selected URL or executable. The signed-in dashboard obtains a terminal bearer through `POST /api/auth/tokens/terminal`, holds it in memory, and sends it to the terminal at `http://localhost:4102`. The terminal validates that bearer against the configured private API and account. No credentials or applicant values belong in handoff request bodies.

| Method | Terminal path | Purpose |
| --- | --- | --- |
| GET | `/workers/handoffs/{attemptId}` | Durable handoff plus authoritative local `browserOpen` state |
| POST | `/workers/handoffs/{attemptId}/open` | Open the headed browser |
| POST | `/workers/handoffs/{attemptId}/resume` | Check resolution, close the browser, and submit proof |
| POST | `/workers/handoffs/{attemptId}/cancel` | Close and cancel this handoff |

Every terminal call requires `Authorization: Bearer <terminal token>`. These POSTs have no body: the host obtains the current fenced lease itself. API routes under `/api/personal/attempts/{attemptId}/handoff` provide durable status; `/request` creates the handoff using the preparation lease and reason. The host's `/open`, `/heartbeat`, `/resume`, and `/cancel` API transitions use `{handoffId, leaseOwner, leaseGeneration}`; resume also requires `proofHash`. Calling the API transition alone does not open a browser. See [handoff contracts](../packages/contracts/src/personal-handoff.ts).

The handoff has its own 90-second lease, renewed every 15 seconds, and a 15-minute browser deadline. An open handoff occupies the user's browser/worker slot; parked jobs do not. The supervisor remains available. After a terminal restart, durable `open` status is not proof that a browser exists: refresh status, allow the stale lease to expire, and explicitly reopen. Cancelled/expired handoffs can reopen with a new generation. Never delete a profile lock until the owning process has stopped and any possible submission is reconciled.

### Greenhouse email verification on the same attempt

The hosted Greenhouse adapter is selected only for a recognized board/post identity. It validates the route loader and mapped controls, supplies frozen answers, and verifies each signed upload against its approved document hash. City and education lookups are restricted to approved values; unknown required controls remain questions for review. Demographic declines require an explicit frozen choice that the source marks as a decline. A required collection/processing consent checkbox needs its own explicit answer; declining demographic questions does not grant consent.

Immediately before the final employer request, the local broker checks the complete JSON against the frozen answers and staged attachments. It saves a private request artifact and calls `challenge/freeze` after `begin-submit`. The API pins the manifest, exact destination, application payload hash, and request hash before forwarding the one permitted final POST. Files may already have been staged; no second application attempt may be used to work around a pending result.

A recognized email-code response keeps the original attempt, identity reservation, capacity debit, and private evidence. Open **Email verification** for that attempt in recent activity and refresh its status. When it is `awaiting_user` with recipient evidence and is not `captcha-retry`, enter the eight letters/digits from the employer's email and choose **Verify once**. The dashboard sends the code to the private local API using a bearer token obtained through the existing terminal-token endpoint. The model has no verification-code tool or access to this request.

| Method | Private API path | Input/result |
| --- | --- | --- |
| GET | `/api/personal/attempts/{attemptId}/challenge` | Sanitized challenge status, code classifier, recipient-present flag, lease, and hashes; no recipient address or application answers |
| POST | `/api/personal/attempts/{attemptId}/challenge/verify` | `{challengeId, code}` with exactly eight alphanumeric characters; requires personal mode and bearer authentication |

The local continuation transport leases the current challenge, checks the saved application and fingerprint, and obtains and consumes a one-use permit. It sends the unchanged application to the exact frozen Greenhouse endpoint with the user's code. These internal `/challenge/lease`, `/checkpoint`, `/continue`, and `/consume` routes enforce ownership, lease generation, expiry, and request hashes; they are not model tools. See [challenge contracts](../packages/contracts/src/personal-challenge.ts) and the [verification controller](../apps/api/src/modules/personal/challenge-verification.controller.ts).

The result is `submitted` with correlated employer acceptance evidence, or `submission_uncertain` with a receipt hash when available. Another recognized code challenge stays on the same attempt and requires another explicit user action. A timeout, unknown response, redirect, expired/consumed permit, or unavailable receipt does not authorize a retry. The UI clears its code field after dispatch; exact request/response evidence is retained in protected mode-0600 files under private storage, including the continuation request containing the code. Keep those files out of logs, model inputs, and Git.

CAPTCHA retry, absent recipient evidence, and unsupported post-submit challenges remain held for user review. This email-only continuation does not solve CAPTCHA, bypass warnings, accept terms, or open a new submission. The pre-submit headed handoff cannot release this post-submit reservation. A public Greenhouse confirmation page alone is never proof of acceptance. See the [connector protocol and evidence](personal-connectors.md#bounded-greenhouse-hosted-form-adapter-2026-09-16).

### Reconcile uncertainty before retrying

`submission_uncertain` means the final action may have happened. Keep its identity reservation and capacity debit. A timeout, closed tab, lost response, or worker restart is not evidence of failure. Handoff, recovery, and cancellation cannot clear a possible submission.

Reconciliation uses `POST /api/personal/attempts/{attemptId}/reconcile` with `{evidence}` from [personal-attempt.ts](../packages/contracts/src/personal-attempt.ts). Evidence identifies the outcome, source kind/URL, capture time, private artifact path/hash, details, and the original manifest hash. The API checks ownership, artifact integrity, manifest, and timing. `submitted` requires employer confirmation evidence, not a `manual_review` claim. A verified `not_submitted` outcome cancels that attempt and releases its reservation; `uncertain` keeps the hold. Reconciliation never repeats the submit action. The dashboard recovery control stays disabled until uncertainty is resolved.

### Remaining employer execution work

Setup readiness is not a guarantee that a specific application can run unattended. The broker implements native controls and one same-origin native POST, plus a separate bounded Greenhouse hosted React flow with signed uploads, a frozen cross-origin JSON request, and same-attempt user email verification. Its supported controls and wire format follow the observed public frontend; unknown widgets, fields, consent authority, and protocol changes remain held. The documented Job Board application API still requires an employer secret; the hosted adapter does not use that API or an employer key. See [the connector evidence and limits](personal-connectors.md#bounded-greenhouse-hosted-form-adapter-2026-09-16).

An unsupported-form hold cannot be cleared by a login/CAPTCHA handoff. Integrated validation and a successful real employer submission are not claimed by this guide. Public board discovery (Greenhouse, Lever, Ashby) can supply relevant investing internships; MBB employer/campus discovery remains a connector gap. Employer instructions prohibiting AI-assisted applications require a manual-only path, and campus-specific restrictions remain eligibility holds.

## Validation

Run the ordered repository gate:

```sh
bun run ci
bun run knip
bun --cwd=apps/api run typecheck
bun --cwd=apps/web run typecheck
bun --cwd=apps/api run test
bun --cwd=packages/contracts run test
"$HOME/Library/Application Support/JobPilotPersonal/tools/dotnet/dotnet" test tests/JobPilot.Terminal.Tests
bun run personal:typecheck
bunx playwright test --config playwright.personal.config.ts
```

PostgreSQL race/recovery tests are opt-in. Set `PERSONAL_TEST_DATABASE_URL` privately to the local test database URL and run the `*.postgres.test.ts` files in `apps/api/src/modules/personal`. They create isolated random schemas and synthetic accounts and drop only those test schemas. Never use a shared production database. Do not paste the URL into logs or tracked files.

The test inventory covers factual preservation, source-cited eligibility and refresh invalidation, attachment integrity, source failures vs empty results, identity and cap races, stale ownership, frozen artifacts, offline/live preview separation, signed Greenhouse uploads, exact final payloads, single-use submit/continuation permits, confirmation evidence, lost responses, restart reconciliation, headed handoff boundaries, cancellation, and mocked dashboard controls. This list does not assert that the full ordered gate has passed. Real applications are not test fixtures.

### Upstream investigation (2026-09-15)

[PR #30](https://github.com/suxrobGM/jobpilot/pull/30) and [PR #34](https://github.com/suxrobGM/jobpilot/pull/34) remain open. This implementation uses transactional reservations and permanent exact identity protection, including alternate Greenhouse postings and historical reservations. It does not assume those proposed upstream patches are merged.

[Issue #36](https://github.com/suxrobGM/jobpilot/issues/36) also remains open. This deployment serves both the dashboard and agent on localhost and verifies their connection directly. It does not claim to repair public-site-to-localhost browser permissions for hosted deployments.

## Remaining inputs and next milestone

Collect availability dates (internship and full-time), locations, compensation amount/currency/period, functions/employers, exclusions, work authorization and sponsorship, experience requirements, and campaign limits. Resolve remaining employment dates/titles and other factual assertions through evidence; importing one master does not establish that conflicting claims are correct. Unknown answers remain unset.

Next: resolve the remaining personal facts, supply explicit per-form screening answers, inspect the final resume, and configure a campaign. Exercise each new employer form adapter with synthetic fixtures before authorizing its use. Expand connectors incrementally with source-health receipts. Publication, real applications, and recruiter outreach were not performed during development.

## Private fact resolutions

`runtime.json` accepts `resumeResolutionOverlay` and `intakeConflicts`. Keep both outside Git. Overlay edits identify a normalized resume JSON pointer, exact expected prior value/hash, replacement or omission, and source citation. Classifications identify the full original conflict hash plus a hashed audit citation. Intake rejects stale source hashes, incorrect prior values, overlapping edits, and unknown conflict IDs. Existing application artifacts are never rewritten by a later intake.

Original comparison leaves remain available as source evidence; a source leaf is not automatically a verified answer. Unknown or disputed required facts still need the user's answer. Optional unsupported claims can be omitted from a new derived draft without deleting them from the original.
