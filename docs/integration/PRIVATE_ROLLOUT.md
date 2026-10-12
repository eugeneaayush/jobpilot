# Private rollout, migration and reapproval runbook

Prepared September 30, 2026 against integration commit `cb1c8c2f`, under review in
[PR #1](https://github.com/eugeneaayush/jobpilot/pull/1). This is an
operational preparation document: no private database was accessed, no campaign was
relaunched, and no real application, message, board login or paid-provider call was
performed while preparing it. Deployment and application approval are separate actions.

## Evidence available now

The [validation report](VALIDATION.md) records the complete implementation gates,
including the disposable PostgreSQL approval-migration test, approval races, withdrawal,
expired/stale packets, exact document checks and synthetic form/receipt recovery.
Those tests establish implementation behavior with fixtures; they do not establish
the readiness of a real account, employer portal or approved provider.

An additional offline preflight called the existing bounded `localToolsCapabilities()`
path successfully. It reported protocol operations `capabilities`, `discover_jobs`,
`render_resume`, `verify_document`, `export_resume_yaml` and `import_resume_yaml`, with
local-tools 1.0.0, restricted JobSpy 1.0.0, RenderCV 2.8, fonts 0.5.1, Typst 0.15.0,
pypdf 6.7.5 and verifier version 1. The preflight used a temporary operation directory
and did not read `runtime.json`, contact an account or connect to PostgreSQL.

## Deployment target and installation

Deploy the private API from the reviewed checkout and keep the runtime outside the
repository. The default macOS runtime is
`~/Library/Application Support/JobPilotPersonal`; `JOBPILOT_PERSONAL_ROOT` can select
an existing alternate runtime. Its directory must remain mode 0700 and `runtime.json`
mode 0600. Preserve the account, signing/encryption keys, source paths and storage root.
Do not create a replacement account or reset the database to make readiness pass.

The hosted API Dockerfile currently installs neither Python/Poppler nor the private
local-tools package. A terminal release also does not install the private API checkout
or Python dependencies. Therefore the existing hosted Compose update alone is not a
private-tool deployment. A packaged/compiled private API needs a preinstalled locked
environment and an absolute `JOBPILOT_LOCAL_TOOLS_PYTHON`; verify the actual executable
and document resources on that host before selecting RenderCV or enabling discovery.

From the selected checkout, the supported dependency commands are:

```sh
bun install --frozen-lockfile
bun run personal:tools:setup
bun --cwd=apps/api run db:generate
```

`personal:tools:setup` explicitly synchronizes the frozen Python 3.12 environment and
probes capabilities. It can install dependencies; API requests never do. Keep
`services/local-tools/uv.lock`, `vendor/` notices and the [component inventory](COMPONENTS.md)
with the deployment. Provide Poppler's `pdftotext` and `pdftoppm` on the API host's PATH.
Do not run `personal:setup` as an update check: it can initialize/start PostgreSQL,
apply migrations, seed boards and configure an account. `db:setup` likewise migrates
and seeds; neither is a read-only preflight.

## Ordered rollout

1. **Record the target and inspect existing state.** Record the reviewed Git SHA,
   runtime directory and intended database identity privately. Inventory private
   campaign modes/statuses, pending attempts, unresolved submission outcomes and
   existing reservations through the dashboard. Identify any task currently filling,
   uploading, authenticating or submitting before stopping it. Keep optional discovery
   configuration absent or `{"leadDiscovery":{"boards":[],"feeds":[]}}`; CBS remains
   the default renderer. This rollout does not activate Stagehand.
2. **Stop private execution before switching code.** Use each private campaign's
   dashboard Stop control, which calls `POST /api/personal/campaigns/:id/stop` with an
   optional `reason`. Allow bounded worker cancellation/status reconciliation to settle,
   then stop the existing `personal:dev` process with its normal SIGINT/SIGTERM path.
   Confirm the supervisor/terminal/browser no longer owns an executing task. Do not
   delete `supervisor.json`, its owner file, leases or browser profiles to force a
   restart. Preserve uncertain attempts and their correlated transport evidence.
3. **Take a consistent private backup.** After execution settles, stop the API and
   keep other writers stopped during migration. Back up the database and the runtime's
   storage/artifacts, source snapshots, configuration and receipts together. Keep the
   backup outside Git with private permissions. Record a restoration check and the
   previous deployment SHA. Capture the preservation fingerprints below immediately
   before migration; normal Stop can cancel pre-submit attempts and release their
   reservations, so compare migration against this settled baseline, not against the
   earlier running campaign state.
4. **Install the reviewed deployment without starting its supervisor.** Run the locked
   dependency commands above and retain runtime permissions. Verify the existing
   runtime still selects the intended database and account. Keep `PERSONAL_MODE`,
   storage settings, dashboard `APP_URL` and `CORS_ORIGINS` aligned with the actual
   private origin. Preserve both approved provider configuration and its original
   verification receipts; new broker hashes require fresh verification.
5. **Apply pending migrations through Prisma once.** Verify `prisma migrate status`
   against the explicitly selected database, then use the existing
   `bun --cwd=apps/api run db:migrate:apply` command with that runtime's `apiEnv`.
   The migration is `20260930020000_require_personal_application_approval`. Do not
   execute its SQL manually, edit migration history, reset the database or seed as
   part of this change. Record Prisma's result and the post-migration checks below.
6. **Restart with every live private campaign stopped.** Only after the migration
   assertions pass, start the existing stack with `bun run personal:dev`, then run
   `bun run personal:doctor`. The command starts API, web, terminal and supervisor;
   there is no separate Python daemon. Doctor reads the private configuration and
   may make an authenticated local readiness request, so it belongs at this real
   runtime checkpoint rather than the offline evidence above. Inspect both its
   `missing` list and readiness result: doctor returning normally is not a claim that
   every blocker cleared. Paused live campaigns must remain paused.
7. **Refresh readiness and affected preparation.** Obtain fresh synthetic boundary
   evidence for the changed broker and complete the existing real-provider verification
   procedure within the approved provider scope. Never rewrite a production receipt
   to match new hashes. Inspect `/api/personal/readiness` and each record's eligibility,
   sources, exact answers/requirements, independent claim review, current renderer and
   PDF-verifier evidence, independent visual review and unresolved declarations.
   General setup readiness does not certify a particular portal. Historical documents
   stay readable, but stale/missing current evidence must hold transmission until the
   affected preparation stages are completed. Changing documents creates new hashes.
8. **Authorize one campaign run, then review individual packets.** The owner explicitly
   launches the intended campaign from the dashboard; launch creates a new run ID and
   freezes its settings/evidence/source scope. Review each application only after that
   run exists. Campaign launch permits preparation/scheduling but cannot replace exact
   application approval. Approval receipts from a previous run cannot be reused.
   Complete the reapproval checklist below before permitting any live fill or upload.
   Start with one intentionally selected application rather than enabling every campaign.
9. **Observe the result and retain evidence.** Confirm the attempt manifest contains
   the bound receipt, exact approved packet/document hashes and matching campaign run.
   Use confirmed receipt evidence to record success. A possible submission remains
   reserved and enters reconciliation; a timeout or worker exit cannot authorize a
   second submit. Preserve caps, receipts and traces across stop/restart. Follow-up
   suggestions remain drafts and do not authorize recruiter messages.

### Selecting the existing database without exposing credentials

For an authorized operator, the following commands read the selected runtime's existing
configuration and pass its `apiEnv` directly to Prisma. They do not print credentials.
Set `JOBPILOT_PERSONAL_ROOT` to the intended existing private directory first if it is
not the default. Review the target identity through the read-only SQL check before
using the second command. Neither command was executed against a private runtime here.

```sh
# Read-only migration status; run from the reviewed repository root.
bun -e 'import { readConfig } from "./scripts/personal/common.ts"; const c = await readConfig(); const p = Bun.spawn([process.execPath, "x", "prisma", "migrate", "status"], { cwd: "apps/api", env: { ...process.env, ...c.apiEnv }, stdout: "inherit", stderr: "inherit" }); process.exitCode = await p.exited;'

# Apply all pending checked-in migrations after the stop/backup checkpoint.
bun -e 'import { readConfig } from "./scripts/personal/common.ts"; const c = await readConfig(); const p = Bun.spawn([process.execPath, "--cwd=apps/api", "run", "db:migrate:apply"], { env: { ...process.env, ...c.apiEnv }, stdout: "inherit", stderr: "inherit" }); process.exitCode = await p.exited;'
```

Use an already configured private PostgreSQL service/environment for SQL and backups,
without placing a credential-bearing connection URL in shell history. Supported
PostgreSQL backup tools are `pg_dump --format=custom --file=PRIVATE_BACKUP_FILE` and
`pg_restore --list PRIVATE_BACKUP_FILE`; listing a dump checks its directory, not a
complete restoration. Perform a real restore rehearsal only in a disposable target.
Private paths and backup receipts are operational inputs, never committed fixtures.

## Read-only migration assertions

Run these queries in the intentionally selected database with all writers stopped.
Store outputs privately before and after migration. PostgreSQL connection metadata
confirms the target without showing applicant data or passwords:

```sql
BEGIN READ ONLY;
SELECT current_database(), current_user, inet_server_addr(), inet_server_port();

SELECT config::jsonb #>> '{personal,mode}' AS mode, status,
       config::jsonb #>> '{personal,approvalPolicy}' AS approval_policy,
       config::jsonb #>> '{personal,enabled}' AS enabled,
       count(*) AS campaigns
FROM campaigns
WHERE jsonb_typeof(config::jsonb -> 'personal') = 'object'
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;

SELECT 'records' AS evidence, count(*) AS rows,
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), '')) AS fingerprint
FROM personal_records t
UNION ALL
SELECT 'attempts', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), ''))
FROM personal_attempts t
UNION ALL
SELECT 'reservations', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), ''))
FROM personal_reservations t
UNION ALL
SELECT 'general_campaigns', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY campaign_id), ''))
FROM campaigns t
WHERE jsonb_typeof(config::jsonb -> 'personal') IS DISTINCT FROM 'object';
COMMIT;
```

These MD5 values are compact before/after comparisons, not cryptographic approval or
artifact hashes. For a large shared database, scope the inventory to the intended owner
and archive an audited snapshot instead of aggregating every row. Do not put private
query output in the PR.

Expected migration result:

- Every campaign whose `personal` configuration is an object contains
  `approvalPolicy: "per-application-v1"`.
- Every `submit` or `live_preview` private campaign is `paused`, `enabled: false`,
  and has JSON `authorization: null`. Offline campaign status/enablement is preserved.
- Record, attempt, reservation and general-campaign fingerprints remain identical
  across the migration checkpoint. This covers append-only record approval history,
  immutable attempt manifests and uncertain reservations. Private artifact bytes are
  preserved in the storage backup and remain hash-verifiable.
- Prisma's `_prisma_migrations` row for the named migration has a successful
  `finished_at`, no `rolled_back_at`, and no failure log. No schema tables, columns
  or enums are introduced by this migration.

Do not start execution if any preservation assertion fails. Inspect the stopped
deployment and backup before further mutations.

## Exact application reapproval checklist

The owner opens **Review application** in `/personal` and checks the current packet:

- Employer, requisition, destination, complete authorized posting evidence and current
  eligibility are correct for this campaign run. Default limits remain 50/day in
  `America/New_York`, three active applications per canonical employer, or stricter
  configured limits. Fit is ordering evidence and never an eligibility override.
- Exact screening values and their source/explicit confirmation are correct, including
  country-specific authorization/sponsorship, compensation units, precise dates,
  complete option arrays and required declarations. Unknown consent or required
  fields remain holds. Shared batch answers do not silently become source facts.
- The final resume and every required attachment have the intended version/hash,
  accepted content, claim review, current exact-byte PDF checks and visual review.
  For official application email, inspect the exact recipient, subject/body and
  attachment payload as well. Optional RenderCV does not bypass these stages.
- The dialog has no unresolved blocker. The owner understands that live filling and
  uploads may transmit applicant data before a final submit. **Approve this application**
  is an explicit grant for this exact packet, not a general campaign permission.
- The recorded approval belongs to the dashboard session/owner and current run, has
  an expiry no later than the earlier of 24 hours or the campaign policy-day boundary,
  and binds to at most one attempt. It cannot authorize automatic resubmission after
  uncertainty. Withdraw stops later transmissions but cannot retract earlier data.

The dedicated approval routes require the HTTP-only dashboard access-token cookie,
configured Origin (or same-origin Referer for GET), session-bound nonce and record
version. A bearer/PAT, `actor: "user"`, copied nonce or agent tool cannot grant approval.
Use the dashboard for grants/withdrawal; do not turn a production application into an
authentication regression test. Re-review is required after expiry/withdrawal or changes
to campaign run, posting/identity/destination, facts/settings, answers/requirements,
documents or applicable email payload. Offline document preparation requires no
application approval.

## Rollback and completion receipt

Before reverting an adapter or renderer, stop affected campaigns and disable that
optional source/backend. Retain the migration and all immutable artifacts, approvals,
attempts, source snapshots and reservations. Reverting the approval boundary must
leave every private live campaign stopped; deploying old code against the new data
is not permission to restore old launch authority. Prefer a forward fix. A backup
restore requires a deliberate reconciliation plan so it cannot erase post-backup
submission evidence or reopen an uncertain application.

Record the deployment SHA, installation/capability receipt, private target identity,
backup/restoration evidence, Prisma migration result, preservation comparisons,
doctor/readiness blockers, provider-verification scope and each reviewed packet's
receipt in private runtime storage. Completion requires these real-runtime checks,
not merely the existing synthetic results. No real-runtime completion receipt was
created as part of this preparation.
