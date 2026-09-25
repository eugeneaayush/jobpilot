import { descriptionText } from "../discovery";
import {
  addPosting,
  boardToken,
  createResult,
  escapeHtml,
  finishResult,
  objectValue,
  postingUrl,
  requiredText,
  rowError,
  sha256,
  sourceDate,
  textValue,
} from "./common";
import { fetchPage } from "./http";
import type { ConnectorOptions, ConnectorPosting } from "./types";

export async function discoverAshby(token: string, options: ConnectorOptions = {}) {
  const board = boardToken(token);
  const sourceUrl = `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`;
  const result = createResult(sourceUrl, options);
  const response = await fetchPage(sourceUrl, result, options);
  if (!response) return finishResult(result);
  try {
    const payload = objectValue(response.payload);
    if (payload.apiVersion !== "1" || !Array.isArray(payload.jobs))
      throw new Error("Invalid Ashby response: expected version 1 job array");
    result.coverage.observedTotal = payload.jobs.length;
    const seen = new Set<string>();
    for (const [index, value] of payload.jobs.entries()) {
      const row = index + 1;
      try {
        const raw = objectValue(value);
        if (raw.isListed === false) {
          result.coverage.excludedUnlisted++;
          continue;
        }
        if (raw.isListed !== true) throw new Error("Missing listing visibility");
        const url = postingUrl(raw.jobUrl, "jobs.ashbyhq.com", board);
        const parts = url.pathname.split("/");
        const nativeId = requiredText(parts[2], "native ID in job URL");
        if (
          parts.length !== 3 ||
          !/^[a-zA-Z0-9_-]+$/.test(nativeId) ||
          (raw.id != null && raw.id !== nativeId)
        )
          throw new Error("Posting URL differs from native identity");
        const descriptionHtml =
          textValue(raw.descriptionHtml) ??
          escapeHtml(requiredText(raw.descriptionPlain, "full description"));
        const location = textValue(raw.location);
        const locations = new Set<string>(location ? [location] : []);
        if (raw.secondaryLocations != null) {
          if (!Array.isArray(raw.secondaryLocations))
            throw new Error("Invalid secondary locations");
          for (const item of raw.secondaryLocations)
            locations.add(requiredText(objectValue(item).location, "secondary location"));
        }
        const publishedAt = sourceDate(raw.publishedAt);
        const posting: ConnectorPosting = {
          source: "ashby",
          boardToken: board,
          sourceRegion: null,
          nativeId,
          internalJobId: null,
          requisitionId: null,
          employerId: null,
          title: requiredText(raw.title, "title"),
          employer: textValue(options.employer) ?? board,
          employerNameSource: textValue(options.employer) ? "configured" : "board_token",
          url: url.href,
          sourceUrl,
          location,
          locations: [...locations],
          descriptionHtml,
          descriptionText: requiredText(
            textValue(raw.descriptionPlain) ?? descriptionText(descriptionHtml),
            "description text",
          ),
          discoveredAt: result.health.checkedAt,
          updatedAt: null,
          firstPublishedAt: null,
          publishedAt,
          publishedAtMeaning: publishedAt ? "last_published" : null,
          deadline: null,
          contentHash: sha256(JSON.stringify(raw)),
          raw,
          provenance: { responseHash: response.contentHash, row, line: null },
        };
        addPosting(result, seen, posting);
      } catch (error) {
        rowError(result, row, error);
      }
    }
    result.coverage.exhausted = true;
  } catch (error) {
    result.health.lastFailure = "failed";
    result.health.errors.push(error instanceof Error ? error.message : "Invalid Ashby payload");
  }
  return finishResult(result);
}
