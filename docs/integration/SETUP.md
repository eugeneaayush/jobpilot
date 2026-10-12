# Private integration setup and operations

Use [PRIVATE_ROLLOUT.md](PRIVATE_ROLLOUT.md) for the ordered deployment, migration,
preservation and reapproval checks. [SOURCE_VALIDATION.md](SOURCE_VALIDATION.md) records
the bounded read-only optional-source probes; a probe does not enable a source.

Use Bun and the existing private API/terminal/database setup. Add `uv`, Python 3.12
(uv can manage it), and Poppler (`pdftotext`, `pdftoppm`) to the local API machine.
The isolated package uses a frozen lockfile:

```sh
bun run personal:tools:setup
bun run personal:doctor
```

`personal:setup` also installs the locked package. It retains its existing database
and terminal setup behavior: do not invoke full setup against a production/private
runtime merely to test these changes. `personal:tools:setup` only synchronizes the
Python environment and probes capabilities. For development tests:

```sh
uv sync --frozen --project services/local-tools
uv run --frozen --project services/local-tools pytest services/local-tools/tests
bun run personal:typecheck
```

The default executable is `services/local-tools/.venv/bin/python` (Windows:
`.venv/Scripts/python.exe`). A deployment may set `JOBPILOT_LOCAL_TOOLS_PYTHON` to an
absolute, preinstalled interpreter. Install the vendored dependency from this same
checkout and lockfile. A compiled API distribution needs an explicit interpreter
path; it cannot assume the source checkout exists beside the executable.

Terminal release archives supply the shared plugin and agent assets, not the private
API checkout, its Node dependencies or the Python environment. The configured private
broker runs from the checkout selected by `personal:setup`, after `bun install`;
its existing MCP SDK and Playwright dependencies come from that installation. Installing
the terminal archive alone does not install `/personal` services. The optional setup
skill section therefore applies only inside an already configured private checkout.

`bun run dev` still starts three applications; `personal:dev` still starts API,
web, terminal and the private supervisor. Python runs per request, with no fifth
daemon. Requests cannot install packages. Child environments exclude API tokens,
database credentials, provider keys and runtime configuration. Each child has a
private operation directory, fixed module, bounded stdin/stdout/stderr and deadline.
The API validates response IDs/schema and returned path/size/hash before publication.
Discovery/render/verification limits are 120/90/30 seconds, subordinate to cancellation.
Capabilities report the installed component versions and PDF-tool availability. Keep
`uv.lock`, the dependency-license inventory and shipped document configuration together
when deploying. Request handlers never repair an installation by downloading tools.

## Optional features

The dashboard's resume renderer defaults to CBS. Choosing RenderCV Classic requires
the installed package and produces a new document/review/approval scope. The YAML
dialog exports a JobPilot bundle. Only supported bundle cuts, ordering and bullet
rewrites can be imported; they become proposals, never a replacement base resume.
External arbitrary YAML/themes/fonts/resources are unsupported. Cover letters use
their existing private renderer. Missing PDF tools hold readiness; they never pass.
Bundle imports support entry/line cuts and ordering plus grounded experience/project
bullet rewrites. Unsupported section/configuration changes return diagnostics. Importing
does not approve the result: the independent claim review, current PDF checks, visual
review and exact application approval still apply.

Optional lead boards and feeds default off. In the private runtime configuration,
explicitly list enabled sources, for example:

```json
{"leadDiscovery":{"boards":["linkedin"],"feeds":[]}}
```

Allowed boards: `linkedin`, `indeed`, `google`. Each query is bounded to one board
and at most 20 leads; access challenges or rate limits stop that source. No stealth,
proxy escalation, board login or account creation exists. Google/board HTML may
change; successful fixture tests are not evidence of live board availability.

Allowed optional feeds: `new_grad`, `summer_internships`. The feed import endpoint
accepts a bounded supplied JSON or README HTML snapshot, season and age filter; it
does not download or redistribute datasets. Primary employer evidence determines
graduate eligibility. Register and authorize the official source for the active
campaign before resolving a lead; lead discovery cannot expand application scope.
An empty result, blocked response, source failure and partial result remain distinct
source receipts. A resolved lead references an existing private record; its original
lead hints never become verified applicant or employer facts.

Use the **Batches** panel for 3–5 eligible related records in one campaign and recruiting
track. Suggestions require at least 60% pairwise overlap of posting-supported campaign
terms. The shared analysis freezes the base/evidence revision; advancing it runs one
existing preparation phase for one member. A blocked member can be retried separately,
and completed members retain their artifacts. Shared factual answers propose source
updates that require explicit acceptance before a refreshed batch can consume them.

The **Fit evidence** dialog explains retained, omitted and unsupported terms without
changing eligibility. The **Follow-up draft** action is available for confirmed
submissions; drafts start after ten quiet days and stop at two per application.
Draft creation and copying perform no send. Delivery/reply observations must reference
existing correlated networking or inbox evidence.

Screening suggestions use the existing sourced answers/settings. Approve scalar
answers individually; a supported multiselect requires the complete unique array of
observed option values. The broker verifies every selected value and the complete
readback before treating the control as filled. Native multiselect and recognizable
Greenhouse ReactSelect controls are bounded implementations; other array/control
shapes, partial selections and conflicting preserved values remain user holds.

## Approval and migration

Apply `20260930020000_require_personal_application_approval` through the existing
migration process only after normal deployment authorization. It stops existing
live private campaigns and removes their old launch authority; history/reservations
and general-plugin campaigns survive. Explicit relaunch is required. It does not
authorize any queued application.

Open **Review application** in the personal record table, inspect exact answers,
source evidence and document versions, then approve the current packet. Only the
owner's HTTP-only dashboard session can grant/withdraw approval, with configured UI
origin and a session-bound nonce. Bearer/PAT requests are rejected. Approval expires
at the earlier of 24 hours or the policy-day boundary; one receipt binds one attempt.
It cannot override eligibility, source scope, caps or provider approval. Live entry
and uploads can transmit before submit. Withdraw stops future transmissions; already
transmitted information cannot be recalled. Ambiguous submission stays reserved for
reconciliation, never automatic resubmission.
GET review requests use the dashboard origin or same-origin referring page; approval
mutations require the configured allowed Origin. Keep `CORS_ORIGINS` aligned with the
actual dashboard deployment. Agent bearer tokens cannot substitute for its session
cookie or grant operation.

Broker changes invalidate existing provider verification hashes. Run fresh synthetic
boundary checks; a fixture pass does not grant real-provider approval. Never edit
the production verification record to make development tests pass.

## Evidence and rollback

Leads/receipts use discovery-run JSON and immutable private artifacts. Fit evidence,
batch references, document verification, sourced answers and append-only approval
history remain in typed record details and existing manifests. Batch source-update
answers must be explicitly accepted through source intake before tailoring consumes
them. Resume completed batch members without regenerating unchanged documents.
Follow-up suggestions remain drafts; no send or automatic application closure occurs.

Pause affected campaigns and disable an optional source/backend before reverting
code. Preserve approval receipts, immutable packet/PDF/report artifacts, source
snapshots, reservations and all submitted/uncertain attempts. Do not delete the data
migration. Rolling back the approval boundary must leave private live execution
stopped. Historical artifacts remain readable but require current verification and
new exact approval before they can become live-ready again.
