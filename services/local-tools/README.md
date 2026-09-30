# Private local tools

The private Bun API owns this one-request Python utility. It supplies a new mode-0700
working directory, sanitized environment, cancellation deadline and validated JSON. No
HTTP daemon, state store, browser, submission, email, scoring or model provider exists here.

Install once from the repository root:

```sh
uv sync --project services/local-tools --locked
uv run --project services/local-tools --locked pytest services/local-tools/tests
```

Runtime uses the installed `.venv/bin/python -m jobpilot_local_tools` directly. It never
invokes uv, installs packages or starts a shell. Input and output are single JSON objects
with `protocolVersion: 1`, `requestId`, `operation`, and `payload`/`result`. Errors are
redacted and typed. Request and response schemas are mirrored in
`packages/contracts/src/personal-local-tools.ts`; shared fixtures verify canonical hashes.
The caller validates every returned artifact's relative filename, bytes and SHA-256.

Operations: `capabilities`, `discover_jobs`, `render_resume`, `verify_document`,
`export_resume_yaml`, and `import_resume_yaml`. JobSpy-derived parsers use one ordinary
HTTP request, no redirect following, transparent user agent and a 20-result bound.
A challenge or 403/429 is a blocked outcome with cooldown. Unknown HTML is an error,
never an empty success. Leads have no eligibility or application authority.

RenderCV 2.8 is installed as a complete locked distribution with bundled Typst. Only the
classic US-letter configuration is accepted. System fonts are disabled; Source Sans 3,
Font Awesome 7 and Noto Sans from the locked fonts distribution are available. Other
installed font families are not selected. Every original date is rendered as free text;
missing end dates never imply Present. Raw Typst/math/resource markup is rejected.

YAML export includes exact source/mapping metadata and the generic RenderCV document.
Import accepts only this bundle and returns proposed cuts, ordering or experience/project
bullet rewrites. It rejects new identities, degrees, dates, skills, numeric claims, resources,
configuration changes, YAML aliases/tags and modified source metadata. Summary changes
must use the existing source/review flow. A rewrite cannot be mixed with a cut/reorder of
the same bullet array. All proposals require the API's independent review before rendering.

Verification binds exact bytes, reads PDFs with pypdf, checks contacts/selected terms,
corruption and page counts, then requires Poppler `pdftotext -bbox-layout` for positioned
word checks. Unknown renderers and missing Poppler hold verification. Margin calibration
comes from shipped templates: CBS resume (39.6pt horizontal, 31pt vertical), CBS cover
letter (54pt), RenderCV classic (50.4pt), with 5pt horizontal / 12pt vertical glyph tolerance (calibrated against the shipped Source Sans header font). Visual review is
still required. These checks do not certify ATS acceptance.

`dependency-licenses.json` inventories the locked environment, bundled Typst metadata and
font notices. Corresponding notice texts are preserved under `notices/`; dependencies and
fonts are installed by uv, not redistributed as binaries here. Fontin has no separate notice
in the installed fonts distribution and is not enabled. RenderCV's MIT declaration covers
its bundled RenderCV Typst package; typst-py is Apache-2.0, with no separate NOTICE in the
installed distribution. JobSpy subset provenance and MIT text are in `vendor/jobspy`.
The verifier is original code inspired by the audit's checklist; no ai-job-search source is
copied, and no vendored package or notice is claimed for that reference.
