"""Restricted parsing subset; see SOURCE.md and LICENSE for upstream provenance."""
import json
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup


def text(node):
    return node.get_text(" ", strip=True) if node else None


def http_url(value):
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        return None
    return value


def parse_linkedin(html):
    soup = BeautifulSoup(html, "html.parser")
    jobs, malformed = [], 0
    for card in soup.select(".base-search-card, .job-search-card"):
        link = card.select_one("a.base-card__full-link")
        href = link.get("href", "") if link else ""
        match = re.search(r"/jobs/view/(?:[^/?]*-)?(\d+)", href)
        if not match:
            match = re.search(r"jobPosting:(\d+)", card.get("data-entity-urn", ""))
        title = text(card.select_one(".base-search-card__title, .sr-only"))
        if not match or not title:
            malformed += 1
            continue
        row_id = match.group(1)
        posted = card.select_one("time[datetime]")
        jobs.append({"sourceRowId": row_id, "originalUrl": f"https://www.linkedin.com/jobs/view/{row_id}",
                     "candidateDestinationUrl": None, "titleHint": title,
                     "companyHint": text(card.select_one(".base-search-card__subtitle")),
                     "locationHint": text(card.select_one(".job-search-card__location")),
                     "postedAt": posted.get("datetime") if posted else None})
    return jobs, malformed


def parse_indeed(html):
    soup = BeautifulSoup(html, "html.parser")
    jobs, malformed = [], 0
    for link in soup.select("a.jcs-JobTitle[data-jk], h2.jobTitle a[data-jk]"):
        row_id = link.get("data-jk")
        title = text(link.select_one("span[title]")) or text(link)
        card = link.find_parent("div", class_="job_seen_beacon") or link.find_parent("td") or link.parent
        if not row_id or not title:
            malformed += 1
            continue
        jobs.append({"sourceRowId": row_id, "originalUrl": f"https://www.indeed.com/viewjob?jk={row_id}",
                     "candidateDestinationUrl": None, "titleHint": title,
                     "companyHint": text(card.select_one('[data-testid="company-name"], .companyName')),
                     "locationHint": text(card.select_one('[data-testid="text-location"], .companyLocation')),
                     "postedAt": None})
    return jobs, malformed


def parse_google(html):
    jobs, malformed = [], 0
    decoder = json.JSONDecoder()
    for marker in re.finditer(r'520084652"\s*:\s*', html):
        try:
            item, _ = decoder.raw_decode(html[marker.end():])
            if not isinstance(item, list) or len(item) < 29:
                raise ValueError("Unknown Google job shape")
            url = http_url(item[3][0][0])
            title = item[0]
            if not url or not isinstance(title, str) or not title:
                raise ValueError("Missing Google job identity")
            jobs.append({"sourceRowId": str(item[28]), "originalUrl": url,
                         "candidateDestinationUrl": url, "titleHint": title,
                         "companyHint": item[1] if isinstance(item[1], str) else None,
                         "locationHint": item[2] if isinstance(item[2], str) else None,
                         "postedAt": None})
        except (ValueError, IndexError, TypeError):
            malformed += 1
    return jobs, malformed


PARSERS = {"linkedin": parse_linkedin, "indeed": parse_indeed, "google": parse_google}
