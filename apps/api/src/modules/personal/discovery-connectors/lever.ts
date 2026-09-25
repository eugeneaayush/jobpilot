import { descriptionText } from "../discovery";
import {
  addPosting,
  boardToken,
  boundedInteger,
  createResult,
  escapeHtml,
  finishResult,
  objectValue,
  postingUrl,
  requiredText,
  rowError,
  sha256,
  textValue,
} from "./common";
import { fetchPage } from "./http";
import type { ConnectorOptions, ConnectorPosting } from "./types";

interface LeverOptions extends ConnectorOptions {
  region?: "global" | "eu";
  pageSize?: number;
  maxPages?: number;
}

function fullDescription(raw: Record<string, unknown>) {
  const opening =
    textValue(raw.description) ??
    escapeHtml(requiredText(raw.descriptionPlain, "full description"));
  if (!Array.isArray(raw.lists)) throw new Error("Missing full description lists");
  const html = [opening];
  for (const value of raw.lists) {
    const item = objectValue(value);
    html.push(
      `<h3>${escapeHtml(requiredText(item.text, "list heading"))}</h3>`,
      requiredText(item.content, "list content"),
    );
  }
  for (const [rich, plain] of [
    ["additional", "additionalPlain"],
    ["salaryDescription", "salaryDescriptionPlain"],
  ] as const) {
    if (raw[rich] != null && typeof raw[rich] !== "string") throw new Error(`Invalid ${rich}`);
    const section =
      textValue(raw[rich]) ?? (textValue(raw[plain]) ? escapeHtml(raw[plain] as string) : null);
    if (section) html.push(section);
  }
  const descriptionHtml = html.join("\n");
  return {
    descriptionHtml,
    descriptionText: requiredText(descriptionText(descriptionHtml), "description text"),
  };
}

export async function discoverLever(token: string, options: LeverOptions = {}) {
  const board = boardToken(token);
  const region = options.region ?? "global";
  if (region !== "global" && region !== "eu") throw new Error("Invalid Lever region");
  const pageSize = boundedInteger(options.pageSize, 100, 100);
  const maxPages = boundedInteger(options.maxPages, 20, 100);
  const apiHost = region === "eu" ? "api.eu.lever.co" : "api.lever.co";
  const jobHost = region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co";
  const sourceUrl = `https://${apiHost}/v0/postings/${board}?mode=json`;
  const result = createResult(sourceUrl, options);
  const seen = new Set<string>();
  const pages = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const url = `${sourceUrl}&skip=${page * pageSize}&limit=${pageSize}`;
    const response = await fetchPage(url, result, options);
    if (!response) break;
    if (!Array.isArray(response.payload)) {
      result.health.errors.push("Invalid Lever response: expected posting array");
      result.health.lastFailure = "failed";
      break;
    }
    const rows = response.payload;
    result.coverage.observedTotal += rows.length;
    if (rows.length > pageSize || (rows.length > 0 && pages.has(response.contentHash))) {
      result.health.errors.push("Lever pagination repeated or exceeded requested page size");
      break;
    }
    pages.add(response.contentHash);
    for (const [index, value] of rows.entries()) {
      const row = page * pageSize + index + 1;
      try {
        const raw = objectValue(value);
        const nativeId = requiredText(raw.id, "native ID");
        const jobUrl = postingUrl(raw.hostedUrl, jobHost, board);
        if (jobUrl.pathname !== `/${board}/${nativeId}`)
          throw new Error("Posting URL differs from native ID");
        const categories = objectValue(raw.categories);
        const location = textValue(categories.location);
        const locations = new Set<string>(location ? [location] : []);
        if (categories.allLocations != null) {
          if (!Array.isArray(categories.allLocations)) throw new Error("Invalid locations");
          for (const item of categories.allLocations) locations.add(requiredText(item, "location"));
        }
        const posting: ConnectorPosting = {
          source: "lever",
          boardToken: board,
          sourceRegion: region,
          nativeId,
          internalJobId: null,
          requisitionId: null,
          employerId: null,
          title: requiredText(raw.text, "title"),
          employer: textValue(options.employer) ?? board,
          employerNameSource: textValue(options.employer) ? "configured" : "board_token",
          url: jobUrl.href,
          sourceUrl: url,
          location,
          locations: [...locations],
          ...fullDescription(raw),
          discoveredAt: result.health.checkedAt,
          updatedAt: null,
          firstPublishedAt: null,
          publishedAt: null,
          publishedAtMeaning: null,
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
    if (rows.length < pageSize) {
      result.coverage.exhausted = true;
      break;
    }
    if (page === maxPages - 1)
      result.health.errors.push("Lever page limit reached before exhaustion");
  }
  return finishResult(result);
}
