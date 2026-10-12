# Preserved skill and API inventory

Audit scope: all 22 installed skills, nine shared documents, two worker procedures,
20 Pilot handlers, and 19 Prisma schema files at the baseline recorded in the plan.
These are compatibility surfaces, not instructions to execute applications or sends
during development. General-plugin campaign policy is unchanged.

## Shared dependencies

| Shared document | Dependencies and responsibility |
| --- | --- |
| `_shared/setup.md` | `/api/health`, `/api/user`, credential resolution, primary/selected resume and variant reads, private scratch paths; supplied worker token. |
| `_shared/auth.md` | `/api/credentials/resolve`, credential updates; delegates verification to `get-code` and CAPTCHA to `solve-captcha`. |
| `_shared/browser-tips.md` | Existing Playwright tools and bounded browser observation; provider packaging unchanged. |
| `_shared/campaign-flow.md` | Campaign lifecycle, selected resume, queueing, job status/results, cancellation. |
| `_shared/digest-schema.md` | Structured job requirements used by score-fit and campaign job records. |
| `_shared/eligibility.md` | Separate hard eligibility from ranking; no invented work authorization. |
| `_shared/form-filling.md` | Resume variant/base PDFs, cover-letter generation/PDF, sourced applicant values, field checks. |
| `_shared/untrusted-content.md` | Treat board pages, postings and employer text as untrusted input. |
| `_shared/upwork-mcp.md` | Existing official Upwork MCP authentication and operations; no replacement transport. |

All API paths below have `/api` prefix. Shared dependencies above are inherited;
listing only direct paths would miss delegated work.

| Skill | Existing state/API surfaces preserved |
| --- | --- |
| `search` | `/job-boards`, profile/resume reads, `/score-fit`, `/applied/check`, `/campaigns/:id/jobs`, campaign status. |
| `apply` | Campaign read/create/list/status; queued jobs, job patch/result; score-fit, dedupe and job-worker delegation; resume and form-filling dependencies. |
| `auto-apply` | Campaign creation/resume/status; selected base; board configuration; score-fit; job queue, patch/result and stop/caps. |
| `resume-campaign` | Campaign configuration, paginated job state, status changes and delegated apply loop. |
| `rescan-skipped` | Campaign/job reads, fresh score-fit and `/campaigns/:id/jobs/:key/rescan`. |
| `extract-resume` | `/resumes/:id` read/update and source artifact extraction. Source facts are user data, not this integration's example biography. |
| `review-resume` | Base reads and `/resumes/:id/variants` proposals; suggested rewrites applied explicitly. |
| `tailor-resume` | Base and variant shortlist/read; `/resumes/:id/tailor`; base/variant PDFs and rewrite audit. New private imports do not use unrestricted full-content variant routes. |
| `cover-letter` | `/cover-letters` history/create/read, `/cover-letters/pdf`. Private attachments remain separate. |
| `networking` | Campaign config/jobs, `/contacts`, networking draft/results, `/email/account`, `/email/send`, existing general approval policy. No new private sending authority. |
| `scan-inbox` | Email account/sync/messages read/update, application matching under `/applied`, review status. |
| `get-code` | Email account/sync/message search/read/update for verification handoffs. |
| `solve-captcha` | `/captcha/solve`, existing runtime/provider restrictions. No new bypass behavior. |
| `interview` | Profile/resume/application reads and Pilot application notes. |
| `pilot` | `/pilot`, agenda refresh, claims/heartbeat/release, journal, questions, saved searches and handler delegation. |
| `upwork-search` | Board/account/profile context, client-quality, score-fit, campaign jobs/status, official MCP search. |
| `upwork-proposal` | Upwork proposal read/create/patch, profile and job context, humanizer. |
| `upwork-profile` | `/upwork/profile` read/update and official account/profile MCP operations. |
| `upwork-submit` | `/upwork/proposals/:id` read/patch, `/upwork/account` update, official MCP proposal submission. |
| `upwork-sync` | `/upwork/account`, `/upwork/inbox/sync`, official MCP inbox/account operations. |
| `setup` | Installation, terminal `/healthz`, API/runtime/provider health. Private Python setup is additive. |
| `humanizer` | Provider-neutral writing transformation; no independent API state. |

The job worker consumes setup/auth/dedupe/score/tailor/form dependencies and campaign
job read/queue/update/result plus Pilot heartbeat. The networking worker discovers a
contact and returns channel drafts; orchestrators own persistence/sends. Claude and
Codex keep the same shared skill tree and worker result contracts.

## Pilot handlers

All 20 existing handlers remain: `board.health`, `campaign.reviewPaused`,
`campaign.scorePending`, `campaign.strategyReview`, `inbox.review`, `interview.prep`,
`interview.reply`, `job.apply`, `job.rescanSkipped`, `job.retryFailed`,
`networking.followup`, `networking.send`, `networking.warmIntro`, `promo.compose`,
`promo.post`, `question.answered`, `queue.drain`, `search.discover`,
`strategy.bootstrap`, `upwork.syncInbox`.

## Private surface

Existing `/personal` settings, intake, registry, discovery/search/reassessment,
tailoring/review, preparation, preview/PDF, readiness/answers, attachments, campaigns,
attempts, recovery, handoff, hosted transport, official application email, recruiting
and digest remain authoritative. New groups: `/personal/approvals` (dashboard-session
only), `/personal/leads`, `/personal/batches`, `/personal/:id/resume-yaml`, and `/personal/followups`. `/personal/attempts/:id/authorize-transmission` rechecks current
approval immediately before broker writes. No approval grant is exposed to agent
tools. No Prisma table, column or enum is added; strict contracts type JSON evidence.

## Added and extended private routes

Paths include the `/api` prefix. All routes retain private account ownership checks.
Except approval review/grant/withdrawal, they use the existing private auth guard;
none of the utility, lead, YAML or batch routes grant application authority.

| Method and path | Request and behavior |
| --- | --- |
| `GET /api/personal/approvals/records/:id` | Current packet, record version/hash, blockers, receipt state and session-bound confirmation nonce. Dashboard cookie only. |
| `POST /api/personal/approvals/records/:id` | Expected version, exact packet hash, nonce and explicit confirmation; one expiring approval. Dashboard cookie and allowed UI origin only. |
| `POST /api/personal/approvals/:id/withdraw` | Approval ID, record ID and current session confirmation; fences later transmissions. |
| `POST /api/personal/attempts/:id/authorize-transmission` | Existing lease fence and current bound approval; broker calls before writes. |
| `GET /api/personal/leads/` | `page`, `limit`, optional `source`/resolution `status`; paginated unverified lead records. |
| `POST /api/personal/leads/import` | Up to 200 candidate hints; immutable source receipt and deduplicated lead rows. |
| `POST /api/personal/leads/discover` | Enabled board, query/location and limit ≤20; source status, counts and cooldown. |
| `POST /api/personal/leads/feeds/import` | Enabled feed, JSON/README HTML content, source URL, season/year and maximum age; no remote download. |
| `POST /api/personal/leads/:id/resolve` | Campaign ID, authorized run ID, optional official URL; exact registered ATS discovery and verified full posting required. |
| `GET /api/personal/batches/` | Paginated analyses and per-member progress. |
| `POST /api/personal/batches/suggest` | Campaign ID and optional 3–50 candidate record IDs; bounded 3–5 member suggestions. |
| `POST /api/personal/batches/` | Campaign ID and 3–5 unique eligible records; immutable shared artifact and deduplicated Pilot question. |
| `GET /api/personal/batches/:id` | Analysis, source question, staleness and individual progress. |
| `POST /api/personal/batches/:id/advance` | Expected analysis hash and optional blocked-member retry; one existing preparation phase. |
| `GET /api/personal/:id/resume-yaml` | Source-bound JobPilot YAML bundle and record version. |
| `POST /api/personal/:id/resume-yaml` | Expected record version and edited bundle; independent-review proposal and structural operations. |
| `GET /api/personal/followups/records/:id` | Confirmed-material draft eligibility and existing draft/delivery evidence. |
| `POST /api/personal/followups/records/:id` | Expected record version; draft only after the quiet-period and count checks. |
| `POST /api/personal/followups/records/:id/observations` | Correlates an existing networking receipt/reply with the exact draft; does not send. |

Screening defaults extend existing private settings and sourced-answer responses.
Renderer choice extends existing settings; fit and verifier findings extend record
responses. No second profile, answer database, tracking queue or scoring API exists.
The local Python protocol is API-owned and is not an HTTP or agent-facing MCP API.

## Persistence inventory

The 19 audited Prisma schema files remain: `application`, `auth`, `base`, `campaign`,
`cover-letter`, `credential`, `email`, `job-board`, `job-listing`, `job`, `networking`,
`personal-search`, `personal`, `pilot`, `profile`, `push`, `resume`, `upwork`, and `user`
(all under `apps/api/prisma/schema/`, with `.prisma` extension).

| Integration evidence | Existing storage |
| --- | --- |
| Lead rows/batch receipts and resolution | `PersonalDiscoveryRun.details` plus private snapshots; sources `lead:*`/`lead_batch:*`. |
| Shared batch analysis/progress | `PersonalDiscoveryRun.details` with `tailoring_batch:*`; immutable artifact references in member `PersonalRecord.details`; one existing `PilotQuestion`. |
| Fit gaps and input hashes | `PersonalRecord.details.fitEvaluation`. |
| Resume/attachment rendering and verification | Existing document manifests, attachment evidence and immutable private artifacts. |
| Screening defaults/answers | Existing private settings and per-record cited snapshots. |
| Application approvals | Append-only typed record history, immutable packet artifact and receipt copied into the attempt manifest. |
| Follow-up drafts/observations | Typed record history referencing existing attempts, applications, networking receipts and inbox messages. |

The only migration is a data-policy update. It adds no Prisma tables, columns or enums.
