# Reference and dependency provenance

Audit baseline: JobPilot `2155f5266b71b16f3b18460f35a31b44efd68508`, September 30,
2026. Reference checkouts were inspected read-only. Pins below describe the audited
snapshots, not permission to update dependencies automatically.

| Component | Upstream and full inspected SHA | Decision and license |
| --- | --- | --- |
| JobSpy | https://github.com/speedyapply/JobSpy — `96e1b12c490fb339f136521741df9ab670da5b60` | MIT. Restricted result parsing under `vendor/jobspy`; see [retained paths/modifications](../../vendor/jobspy/SOURCE.md) and [original notice](../../vendor/jobspy/LICENSE). The sidecar supplies ordinary HTTP. No proxy rotation, TLS impersonation, account cookies, full-description crawling, Glassdoor or ZipRecruiter. |
| jobspy-mcp-server | https://github.com/borgius/jobspy-mcp-server — `5f93ffe96091eb747c6ee5ffbbd076e3512de705` | MIT declared, no tracked license file. Interface reference only; no shell/Docker wrapper code retained. |
| RenderCV | https://github.com/rendercv/rendercv — `1d4b87bc427e4cf61c0ef49623c971b0e2224708` | MIT. Install complete locked RenderCV 2.8 distribution; Python 3.12 and Typst. No LaTeX, arbitrary theme/resource loading or copied incomplete submodule checkout. |
| Resume-Matcher | https://github.com/srbhr/Resume-Matcher — `9c05e423dfde44a5b4bb398d2dc7507194252ded` | Apache-2.0; no NOTICE at this SHA. Gap-analysis concepts only; no copied implementation, LLM stack, ATS composite score, UI or generator. |
| ai-job-search | https://github.com/MadsLorentzen/ai-job-search — `d7287ec83493102f253282fab07bd88412e7dd50` | MIT. Checklist/reference concepts only; the verifier and follow-up logic are independently written. No upstream scripts, excerpts, fixtures, templates, portal clients, tracker or profile state retained. |
| resume-tailoring-skill | https://github.com/varunr89/resume-tailoring-skill — `9a4a0f20f5983d1b533627b8c5191acd1ca0cd89` | MIT. Shared interview/gap-analysis concepts only; no files or excerpts retained. The batch service is independently written. No generated experience libraries, title inflation or automatic facts. |
| Stagehand | https://github.com/browserbase/stagehand — `ad2bf12ea7abd95bb1d6f3a59600842a0954fffb` | MIT; inspected v4.1. Deferred fixture research only. No production dependency or activation. |
| browser-use | https://github.com/browser-use/browser-use — `4cbe921673b48a488f5415d9159249afd12a625b` | MIT. Evaluation reference only; no second autonomous browser planner. |
| OpenJobAutofill | https://github.com/Br1an67/OpenJobAutofill — `005eda98841b3671ead615ebfde5922f0dfd7c36` | MIT. Narrow classification reference; no files or snippets retained. See [OpenJobAutofill provenance](../../vendor/openjobautofill/PROVENANCE.md). Broker remains authoritative; extension UI/storage, regional defaults and filled-without-readback behavior excluded. |
| invisible_playwright_mcp | https://github.com/feder-cr/invisible_playwright_mcp — `94c9736610b6ca54ed115e6241d8637f4d25a4c3` | MIT. Excluded completely. Neither answer-bank implementation nor approved fallback. |
| New-Grad-Positions | https://github.com/SimplifyJobs/New-Grad-Positions — `c4b52dc057ed53cef081d4cd5f913c4392565421` | No tracked license. Independently written optional lead parser; no updater code or datasets redistributed. |
| Summer2027-Internships | https://github.com/SimplifyJobs/Summer2027-Internships — `d648ee167b953cb3f5aedfdc0208c033e03f1c6e` | No tracked license. Same restrictions, plus explicit season filtering. Feed degree flags do not establish graduate eligibility. |

The audited runtime requirements explain why these are separate component decisions:
JobSpy uses Python ≥3.10; its MCP wrapper combines Node, Python and Docker. RenderCV
2.8 uses Python ≥3.12 and Typst. Resume-Matcher is a Python ≥3.13/Next.js application,
and browser-use requires Python ≥3.11. Stagehand v4.1 supplies TypeScript/Python SDKs;
OpenJobAutofill is a JavaScript extension. The tailoring references are chiefly
Markdown/Python workflow material, invisible_playwright_mcp is Python, and the feeds
are structured JSON plus Markdown/HTML. None of these inspected runtime requirements
implies that an excluded component is installed or supported by JobPilot.

The runtime's authoritative versions and hashes are in
[`services/local-tools/uv.lock`](../../services/local-tools/uv.lock). The installed
distribution, Typst and font inventory is
[`dependency-licenses.json`](../../services/local-tools/dependency-licenses.json),
with retained notices in that package. Only shipped permitted font/theme settings
are enabled. A package's presence is not approval to load its arbitrary resources.

For future updates record upstream URL, full SHA/version, retained paths, changes,
license and applicable notices. Preserve MIT notices. Any future Apache code copy
must identify modifications and retain applicable notices; do not invent a NOTICE
when upstream has none. Feed snapshots belong in private immutable artifacts,
never committed fixture datasets. Fixtures are synthetic.

## Retained material and implementation differences

Only JobSpy parsing code is adapted from the audited reference repositories. Its
[source record](../../vendor/jobspy/SOURCE.md) identifies the retained rewritten
module, upstream input files, removals and new Indeed parser. No JobSpy network
stack, MCP wrapper, Docker runner or unrestricted top-level package is installed.

The approved plan allowed small copies from ai-job-search, resume-tailoring-skill
and OpenJobAutofill. The implementation instead uses original code and synthetic
fixtures for those concepts. These are reference-only decisions, so no nonexistent
vendor directory, upstream script, license file or NOTICE is represented as copied.
Resume-Matcher contributes concepts only; its Apache code is not a dependency.

RenderCV is installed from the complete locked distribution, not copied from the
inspected checkout. The license inventory identifies the installed packages and
notice hashes, including bundled fonts and Typst; versions in that inventory do not
claim testing on every supported installation platform. Fontin is not enabled and
has no separate notice in the inspected font distribution. The selected fonts are
Source Sans 3, Font Awesome 7 and Noto Sans; system fonts are disabled.

Retained notices use LF line endings with trailing whitespace removed. Their words
are unchanged; inventory hashes describe these normalized retained bytes.

The two unlicensed feed repositories are optional input formats only. Their updater
code and datasets are not retained. User-supplied bounded snapshots stay private;
committed feed fixtures are synthetic and do not establish live-source availability.

## Deferred Stagehand evaluation

A later fixture-only experiment must prove same-session control, exclusive profile
ownership, unchanged field state, approved inference/data egress, no paid fallback,
and measurable recovery improvement against the current broker. Capture attempts,
success rate, latency, failure reasons and before/after state. Session handoff must
not expose broker-owned applicant values to an unapproved planner. A written go/no-go
decision and separate production approval are required; this integration does not
activate Stagehand.
