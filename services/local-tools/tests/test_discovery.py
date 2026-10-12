import json

import httpx
import pytest
from jobpilot_jobspy import parse_google, parse_indeed, parse_linkedin

from jobpilot_local_tools.discovery import discover
from jobpilot_local_tools.protocol import Discovery

LINKEDIN = '''<li><div class="base-search-card" data-entity-urn="urn:li:jobPosting:123">
<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/analyst-123?trackingId=x">Apply</a>
<h3 class="base-search-card__title">Research Analyst</h3><h4 class="base-search-card__subtitle">Example Co</h4>
<span class="job-search-card__location">New York</span><time datetime="2026-09-01"></time></div></li>'''


def transport(code=200, text=LINKEDIN, headers=None):
    return httpx.MockTransport(lambda request: httpx.Response(code, text=text, headers=headers))


def test_linkedin_hints_not_application_authority():
    rows, malformed = parse_linkedin(LINKEDIN)
    assert malformed == 0
    assert rows[0]["originalUrl"] == "https://www.linkedin.com/jobs/view/123"
    assert rows[0]["companyHint"] == "Example Co"
    assert rows[0]["candidateDestinationUrl"] is None


def test_indeed_preserves_job_identity_parameter():
    rows, malformed = parse_indeed('''<div class="job_seen_beacon"><h2 class="jobTitle"><a class="jcs-JobTitle" data-jk="abc123"><span title="Analyst">Analyst</span></a></h2><span data-testid="company-name">Example Co</span></div>''')
    assert rows[0]["originalUrl"] == "https://www.indeed.com/viewjob?jk=abc123"
    assert malformed == 0


def test_google_public_array_fields():
    row = [None] * 29
    row[0:4] = ["Analyst", "Example Co", "Remote", [["https://boards.greenhouse.io/example/jobs/123"]]]
    row[28] = "job-123"
    rows, malformed = parse_google('"520084652":' + json.dumps(row))
    assert malformed == 0
    assert rows[0]["sourceRowId"] == "job-123"
    assert rows[0]["candidateDestinationUrl"] == rows[0]["originalUrl"]


def test_complete_deduplicated_bounded_result():
    payload = Discovery(board="linkedin", query="analyst", limit=1)
    result = discover(payload, transport(text=LINKEDIN * 2))
    assert result["status"] == "complete"
    assert len(result["leads"]) == 1
    assert result["leads"][0]["resolutionStatus"] == "unresolved"
    assert result["leads"][0]["responseSha256"] == result["responseSha256"]


@pytest.mark.parametrize("code", [401, 403, 429, 302])
def test_blocked_responses_have_cooldown_no_retry(code):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(code, text="blocked", headers={"Retry-After": "900"})
    result = discover(Discovery(board="indeed", query="analyst", limit=20), httpx.MockTransport(handler))
    assert result["status"] == "blocked"
    assert result["cooldownSeconds"] == 900
    assert result["leads"] == []
    assert len(calls) == 1
    assert calls[0].headers["User-Agent"] == "JobPilotLocalDiscovery/1.0"


@pytest.mark.parametrize("body,status", [("No matching jobs found", "empty"), ("Unexpected response format", "error"), ("Verify you are human", "blocked")])
def test_empty_is_distinct_from_unrecognized_or_challenged(body, status):
    result = discover(Discovery(board="google", query="analyst", limit=10), transport(text=body))
    assert result["status"] == status


def test_partial_preserves_successful_rows():
    result = discover(Discovery(board="linkedin", query="analyst", limit=20), transport(text=LINKEDIN + '<div class="base-search-card">Invalid row</div>'))
    assert result["status"] == "partial"
    assert len(result["leads"]) == 1


def test_timeout_redacted():
    def timeout(request):
        raise httpx.ReadTimeout("private text and URL", request=request)
    result = discover(Discovery(board="linkedin", query="analyst", limit=1), httpx.MockTransport(timeout))
    assert result["status"] == "error"
    assert "private text" not in json.dumps(result)


def test_oversized_source_response_does_not_persist():
    result = discover(Discovery(board="linkedin", query="analyst", limit=1), transport(text="x" * 2_000_001))
    assert result["status"] == "error"
    assert result["snapshotFilename"] is None
