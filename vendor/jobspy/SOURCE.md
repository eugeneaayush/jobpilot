# JobSpy subset

Upstream: https://github.com/speedyapply/JobSpy
Commit: `96e1b12c490fb339f136521741df9ab670da5b60`
License: MIT; original notice retained in LICENSE.

Adapted `jobspy/linkedin/__init__.py` card field selection and stable job URL construction;
adapted `jobspy/google/util.py` initial result marker and `jobspy/google/__init__.py`
result array field mapping. `src/jobpilot_jobspy/__init__.py` is the retained, rewritten subset.
Indeed public-card parsing is newly implemented, informed by upstream's normalized fields.

Removed all upstream networking, shared scraper classes, credential/API headers, proxy
support, impersonation, device behavior, pagination, description crawling and other boards.
The caller supplies already fetched bounded text. Parsers return unverified lead hints.
No JobSpy top-level package is installed. Networking lives in the private sidecar and uses
ordinary HTTP with one request, transparent user agent, no redirects or retries.
