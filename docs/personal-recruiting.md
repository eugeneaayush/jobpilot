# Private MBB recruiting bridge

`bun run personal:recruiting --source-root /absolute/path/to/mba-buyside` reads only
`data/mbb/recruiting-operations.json` and source Git provenance. It validates an explicit
version-1 manifest, then writes a private read-only snapshot, receipt, and self-contained HTML
control center. The JSON contract is defined in
`packages/contracts/src/personal-recruiting.ts`.

The default output is `$JOBPILOT_PERSONAL_ROOT/recruiting` when that variable is set; otherwise
it is `~/Library/Application Support/JobPilotPersonal/recruiting`. Use `--runtime-root` to
select another private directory outside both repositories. Output directories use mode
`0700`, files use `0600`, and symlink escapes are rejected.

Open `recruiting/latest.html` for the offline control center. `latest.json` contains the full
validated snapshot. `snapshots/` retains immutable JSON, HTML, and receipt files keyed by the
source path/hash and Git state. Reimporting unchanged input and Git state reuses the original
`capturedAt`. Stale warnings reflect the age of the recorded evidence; an unchanged reimport
does not refresh that evidence or the original capture time. Receipts record the source
SHA256, Git HEAD, dirty status, capture time, and artifact SHA256 values. The capture time
describes an import, not a fresh portal check.

The source manifest SHA256 and saved snapshot bytes are the canonical record of the captured
evidence. Git HEAD and the whole-tree dirty flag provide supplementary repository context;
they do not establish that the manifest is tracked or committed. Relocating the source root
forks the immutable provenance chain even when the manifest bytes are unchanged, because the
canonical source root participates in snapshot identity.

The offline HTML includes private evidence locators and must remain private. Do not serve it
through the API; API consumers must use the separate projection that omits private locators.

Only one import may publish into a runtime at a time. An interrupted process can leave
`recruiting/.import.lock`; inspect its PID and ensure that process has stopped before removing
the lock and retrying. A successful retry reconciles both latest artifacts from the immutable
snapshot. Source and rendered artifacts are each limited to 2 MiB.

Exactly three distinct MBB firm IDs—`mckinsey`, `bain`, and `bcg`—are the version-1 boundary;
other firms are outside this manifest contract. Office preferences retain their supplied
order. Evidence is identified by stable IDs and every reference must resolve. Dates use real
`YYYY-MM-DD` values or timezone-qualified ISO
timestamps. Unknown facts remain explicit `null` or `unknown`; registration and attendance
are independent fields. A verified deadline requires a date and evidence reference.

This command reads no résumé or contact pools, writes nothing to the source repository,
and performs no network requests, messages, event registrations, applications, or campaign
activation. Source strings remain inert text, and HTML escapes all supplied content.

Scoped checks:

```sh
bun test scripts/personal/recruiting*.test.ts
bun run personal:typecheck
bunx biome check packages/contracts/src/personal-recruiting.ts scripts/personal/recruiting*.ts
```
