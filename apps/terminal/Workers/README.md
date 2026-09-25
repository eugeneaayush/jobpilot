# Private structured tasks

These endpoints are separate from the interactive PTY. Every request requires
`Authorization: Bearer <private API token>`. The host authenticates against the
fixed loopback `JOBPILOT_API` origin; callers cannot select an API URL or command.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/workers/capabilities` | Defaults and broker configuration presence |
| POST | `/workers/tasks` | Accept an immutable task; return 202 and its snapshot |
| GET | `/workers/tasks/{taskId}` | Read the authenticated user's task and recent events |
| POST | `/workers/tasks/{taskId}/cancel` | Request cancellation; poll until finished |
| POST | `/workers/tasks/{taskId}/resume` | Resume bounded pre-submission work from its checkpoint |
| GET | `/workers/handoffs/{attemptId}` | Read the API-authorized parked browser handoff |
| POST | `/workers/handoffs/{attemptId}/open` | Open the headed local browser under its exclusive profile lease |
| POST | `/workers/handoffs/{attemptId}/resume` | Verify user handling, close the browser and return the job to preparation |
| POST | `/workers/handoffs/{attemptId}/cancel` | Close this browser and cancel its handoff |

Start body:

```json
{
  "taskId": "00000000-0000-4000-8000-000000000001",
  "role": "worker",
  "adapter": "mock",
  "kind": "prepare_apply",
  "input": {"mockScenario": "success"}
}
```

`role` is `supervisor` or `worker`. Supervisors use `codex` or `mock` and kind
`plan`. Workers use `claude` or `mock` and kind `score`, `prepare_apply`, `apply`,
or `reconcile`. `inputHash`, when supplied, must match SHA-256 of compact input
JSON in its existing property order. Input is capped at 64 KiB. Duplicate IDs
are idempotent only with identical role, adapter, kind, and input hash.

Codex supervision accepts the verified 0.154.0-alpha.6.2, 0.155.0-alpha.2.6, 0.155.0-alpha.9.2, 0.155.0-alpha.16 and 0.155.0-alpha.16.3 app-server interfaces on
macOS. Every turn has `environments: []`, which removes environment tools;
configured MCP servers, apps, plugins, hooks, browsers and subagents are disabled.
A macOS sandbox denies reads of private application files, global AGENTS files
and memories; paths are canonicalized before building the policy. Its public-directory
exception must be a strict descendant of the private runtime, including after symlink resolution. The host
requires no automatic instruction sources before sending public metadata.
The saved model/provider remain selected. Capabilities expose
`codexSupervisorEnabled` and a safe `codexSupervisorBlockReason` when unavailable.
Any unexpected tool/approval request fails closed. Mock supervision remains available.
The CLI version and initialization product/version must exactly match this list;
unverified upgrades remain blocked until their isolation protocol is checked.

The September 20 verification of 0.155.0-alpha.9.2 checked the generated experimental
schema and exercised new and resumed sessions with synthetic hostile public metadata.
Both sessions exposed no environment or automatic instructions, disabled configured MCP
servers, and returned proposals without tool actions. A private-file canary was denied
by the macOS sandbox; file-write and loopback-network canaries remained untouched.
The verification used no applicant data and made no employer requests.

The September 24 verification of 0.155.0-alpha.16 checked the generated experimental
schema and passed bounded synthetic hostile-metadata turns in a new session and a
fresh-process resumed session. Both had empty automatic instruction sources; twelve
configured MCP servers exposed zero tools, and neither turn issued a tool or approval
request. Saved model, reasoning effort and service tier were preserved without a
provider override. The private-read canary was denied, while write and loopback-network
canaries remained untouched. No applicant data or employer requests were involved.
Resume restored a local environment before the turn; the existing per-turn
`environments: []` override then produced an explicitly empty environment selection.
That override is required for resumed turns and must remain in place. These probes
verify bounded isolation behavior, not employer adapters or application eligibility.

The September 24 evening verification of 0.155.0-alpha.16.3 independently exported
its experimental schema and repeated both hostile-metadata turns with fresh canaries
and a new session, resumed in a fresh process. Both turns exposed zero tools across
twelve configured MCP servers, had empty automatic instruction sources, and returned
valid proposals without tool or approval requests. The mandatory per-turn empty
environment override remained effective after resume. Saved model, reasoning effort
and service tier were preserved without a provider override. The synthetic private
read was denied; write and loopback-network canaries remained untouched. The installed
executable hash was unchanged across both probes. No applicant data or employer
requests were used.

Snapshots include status, phase, attempt number, provider session ID, immutable
input hash, heartbeat and lease timestamps, submission uncertainty, result,
error, and numbered recent events. Final structured results contain `outcome`,
`summary`, `nextAction`, and `data:{mock,attemptId,receipt,taskKind}`. A model's
`dispatch_worker` response is only a proposal; it never runs a command itself.

Mock scenarios: `success`, `wait`, `retry`, `fail`, `needs_user`. Mock runs never
call the broker or application API and always mark result data as mock.

Login, account creation, CAPTCHA, terms, security warning and verification
handoffs are separate from model execution. The private API owns their durable
status, affected record/attempt, opaque profile key, allowed origin and independent
lease. Terminal snapshots add `browserOpen` and fixed status events, never page
content, credentials, applicant answers or document paths. Credentials and new
passwords remain user-entered. The broker enforces action-time handling and never
bypasses security warnings or permits automatic application submission.

The host starts only the configured `bun personal-browser.ts --handoff` process,
with scoped authority in its environment. Its JSONL commands are `open`, `resume`
and `cancel`; events are `ready`, `resolved`, `blocked` and `closed`. A resolved
event must carry a SHA-256 `proofHash`; the private API validates the corresponding
artifact before enabling fresh preparation. Terminal never resumes a prior apply
task or submits in response to this event. The browser closes before API resume.

An open handoff owns the existing worker slot and the broker's exclusive browser
profile; the supervisor remains available. Parked jobs consume no terminal slot.
The host renews the independent handoff lease every 15 seconds and closes the
browser on lease loss or the 15-minute deadline. After a restart, `browserOpen`
is false and the user must explicitly reopen the headed browser. Private handoff
snapshots live under `runtime/handoffs/<user hash>/<attempt UUID>/state.json` with
mode 0600. Authentication tokens remain only in process memory/environment.

Real workers require API-issued `input.attemptId`, `input.leaseOwner`, and
`input.leaseGeneration`. Set `JOBPILOT_WORKER_MCP_CONFIG` to a private JSON
template with one `mcpServers.jobpilot` entry: command `bun`, args containing one
absolute `personal-browser.ts` path. The host constructs a per-attempt MCP env
block, writes it with mode 0600, and deletes it after execution. The API bearer
is removed from the model process environment and redacted from stored output.
Application database credentials, JWT/master secrets, all JobPilot scope variables,
and private storage paths are also removed from every model process environment.
Configured model/provider settings and their authentication remain inherited.
Missing broker configuration blocks real workers. Only the six scoped JobPilot
tools are exposed; non-apply tasks cannot call `submit_application`.

Claude runs with `--bare`, an empty built-in tool set, and only its scoped MCP.
Bare mode skips CLAUDE.md, memories, plugins and other automatic customizations.
Only saved provider/model/auth settings are copied to a mode-0600 per-run settings
file; it is deleted after execution. The model prompt contains only attempt and
lease identifiers plus a fixed procedure. Broker outputs enforce the approved
data scope. No résumé, answers, private task instructions or applicant fields are
copied into the prompt.

Private `runtime.json.providerApproval` needs `verified: true`, nonempty
`provider` and `model`, and either `allowMetadataOnly: true` or explicit
`allowApplicantData: true`. Its `verification` includes `providerConfigPath`,
`providerConfigSha256` and `brokerSha256`. The provider path must match the actual
Claude settings path; both hashes are checked before execution and in capability
readiness. Broker hash is SHA-256 of UTF-8 `<relative path>:<file SHA256>` lines
joined with one newline and no trailing newline: `personal-browser.ts` first,
then every `.ts` file recursively under `personal-browser/`, sorted ordinally
by its POSIX relative path. New imported modules also invalidate earlier receipts.
Drift invalidates approval. Capabilities expose `providerApproved`,
`providerApprovalScope` and `providerApprovalBlockReason`. Mock tasks do not need approval.

Defaults: one supervisor and one worker slot per user, 15-minute task deadline,
15-second heartbeat, 90-second API/local lease, 10-second cancellation grace,
1 MiB combined output, and at most two retries before possible submission.
Once submission is possible the task never retries or resumes. A verified API
receipt is required for apply completion; interruption otherwise yields
`outcome_unknown` and requires a new reconciliation task.

State and per-attempt directories live under
`JOBPILOT_PERSONAL_ROOT/runtime/tasks/<user hash>/<task UUID>`, outside Git.
The default root is `~/Library/Application Support/JobPilotPersonal`. Supervisor
resume uses its explicit saved Codex session ID. Worker attempts always use
fresh Claude sessions. No configured provider or model is overridden.

Interface evidence: the installed app-server schema documents empty environments
as disabling environment access; OpenAI's [thread protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
and [tool registration](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)
show environment-gated shell, patch and image tools. The [MCP configuration reference](https://developers.openai.com/codex/config-reference)
documents per-server `enabled: false`. Claude 2.1.263 `--help` documents bare-mode
context isolation and explicit settings/MCP support.
