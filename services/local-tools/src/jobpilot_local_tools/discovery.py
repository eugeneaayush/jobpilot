from datetime import datetime, timezone

import httpx
from jobpilot_jobspy import PARSERS

from .files import digest, write_private
from .protocol import Discovery

MAX_RESPONSE_BYTES = 2_000_000
ENDPOINTS = {
    "linkedin": "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
    "indeed": "https://www.indeed.com/jobs",
    "google": "https://www.google.com/search",
}


def discover(payload: Discovery, transport=None):
    params = {"keywords": payload.query, "location": payload.location or "", "start": 0}
    if payload.board == "indeed":
        params = {"q": payload.query, "l": payload.location or "", "limit": payload.limit}
    elif payload.board == "google":
        query = f"{payload.query} jobs"
        if payload.location:
            query += f" near {payload.location}"
        params = {"q": query, "udm": "8"}
    result = {"board": payload.board, "status": "error", "leads": [], "snapshotFilename": None,
              "responseSha256": None, "cooldownSeconds": None, "diagnostics": []}
    try:
        with httpx.Client(timeout=25, follow_redirects=False, trust_env=False, transport=transport,
                          headers={"User-Agent": "JobPilotLocalDiscovery/1.0", "Accept": "text/html"}) as client:
            with client.stream("GET", ENDPOINTS[payload.board], params=params) as response:
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        result["diagnostics"] = [{"code": "response_too_large", "message": "Source response exceeded the size limit"}]
                        return result
                    chunks.append(chunk)
                raw = b"".join(chunks)
                result["responseSha256"] = digest(raw)
                result["snapshotFilename"] = write_private("discovery.html", raw).name
                content = raw.decode("utf-8", errors="replace")
                if response.status_code in (401, 403, 429) or 300 <= response.status_code < 400 or any(
                    marker in content.lower() for marker in ("captcha", "unusual traffic", "verify you are human", "security checkpoint")
                ):
                    retry = response.headers.get("retry-after", "3600")
                    result.update(status="blocked", cooldownSeconds=min(max(int(retry), 60), 86400) if retry.isdigit() else 3600,
                                  diagnostics=[{"code": "source_blocked", "message": "Source denied or challenged ordinary HTTP access"}])
                    return result
                if response.status_code != 200:
                    result["diagnostics"] = [{"code": "source_http_error", "message": f"Source returned HTTP {response.status_code}"}]
                    return result
                jobs, malformed = PARSERS[payload.board](content)
                seen = set()
                now = datetime.now(timezone.utc).isoformat()
                for job in jobs:
                    if job["originalUrl"] in seen:
                        continue
                    seen.add(job["originalUrl"])
                    result["leads"].append({**job, "source": payload.board, "discoveredAt": now,
                                            "responseSha256": result["responseSha256"], "resolutionStatus": "unresolved"})
                    if len(result["leads"]) == payload.limit:
                        break
                if result["leads"]:
                    result["status"] = "partial" if malformed else "complete"
                elif any(marker in content.lower() for marker in ("no matching jobs", "no jobs found", "did not match any jobs", "no results found")):
                    result["status"] = "empty"
                else:
                    result["diagnostics"] = [{"code": "unsupported_source_shape", "message": "The response did not contain a recognized listing or explicit empty result"}]
                if malformed:
                    result["diagnostics"].append({"code": "malformed_rows", "message": "Some source rows could not be parsed"})
    except httpx.TimeoutException:
        result["diagnostics"] = [{"code": "source_timeout", "message": "Source request timed out"}]
    except httpx.HTTPError:
        result["diagnostics"] = [{"code": "source_network_error", "message": "Source request failed"}]
    return result
