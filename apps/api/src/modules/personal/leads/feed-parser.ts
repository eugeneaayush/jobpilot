import type { PersonalLeadCandidate } from "@jobpilot/contracts/personal-leads";
import { descriptionText } from "../discovery";
import { manifestHash } from "../persistence-policy";
import { normalizeLeadUrl, officialLeadDestination } from "./lead-policy";

interface FeedOptions {
  feed: "new_grad" | "summer_internships";
  format: "json" | "readme_html";
  sourceUrl: string;
  seasonYear: number;
  season: "summer" | "spring" | "fall" | "winter" | "any";
  maxAgeDays: number;
  now?: Date;
}
interface FeedResult {
  candidates: PersonalLeadCandidate[];
  excluded: number;
  duplicates: number;
  status: "complete" | "partial" | "failed";
  diagnostics: string[];
}
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
function seasonsMatch(title: string, terms: unknown, options: FeedOptions): boolean {
  const values = Array.isArray(terms)
    ? terms.filter((value): value is string => typeof value === "string")
    : [];
  const scope = values.length ? values.join(" ") : title;
  const years: string[] = scope.match(/\b20\d{2}\b/g) ?? [];
  if (years.length && !years.includes(String(options.seasonYear))) return false;
  const seasons =
    scope
      .toLowerCase()
      .match(/\b(?:summer|spring|fall|autumn|winter)\b/g)
      ?.map((value) => (value === "autumn" ? "fall" : value)) ?? [];
  return options.season === "any" || !seasons.length || seasons.includes(options.season);
}
function postedDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value * 1000 : Date.parse(text(value));
  if (!Number.isFinite(time) || time < 0 || time > 8.64e15) throw new Error("Invalid posting date");
  return new Date(time).toISOString();
}
function hidden(row: string) {
  return /\bhidden(?:\s|[=>])|aria-hidden\s*=\s*["']true["']|display\s*:\s*none|visibility\s*:\s*hidden/i.test(
    row,
  );
}
function htmlRows(content: string) {
  const rows: Record<string, unknown>[] = [];
  let recognized = false;
  for (const table of content.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    let company = "";
    let headers: string[] = [];
    for (const row of table[1]!.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [...row[2]!.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)];
      if (cells.some((cell) => cell[1]?.toLowerCase() === "th")) {
        headers = cells.map((cell) => descriptionText(cell[2]!).toLowerCase());
        continue;
      }
      const companyIndex = headers.indexOf("company");
      const titleIndex = headers.findIndex((header) => /^(?:role|position|title)$/.test(header));
      const linkIndex = headers.findIndex((header) => /application|apply|link/.test(header));
      if (companyIndex < 0 || titleIndex < 0 || linkIndex < 0) continue;
      recognized = true;
      const value = (index: number) => descriptionText(cells[index]?.[2] ?? "");
      const current = value(companyIndex).replace(/^[🔥🚀\s]+/u, "");
      if (current && !/^(?:↳|↪|↴|→|ditto|〃)$/.test(current)) company = current;
      const links = [
        ...(cells[linkIndex]?.[2] ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi),
      ].map((link) => descriptionText(link[1]!));
      const url =
        links.find((link) => {
          try {
            officialLeadDestination(link);
            return true;
          } catch {
            return false;
          }
        }) ??
        links.find((link) => {
          try {
            return !new URL(link).hostname.endsWith("simplify.jobs");
          } catch {
            return false;
          }
        });
      const dateText = value(headers.findIndex((header) => /age|date|posted/.test(header)));
      rows.push({
        id: `html-${manifestHash({ company, title: value(titleIndex), url }).slice(0, 24)}`,
        company_name: company,
        title: value(titleIndex),
        locations: [value(headers.findIndex((header) => /location/.test(header)))],
        url,
        active: Boolean(url) && !/🔒|\bclosed\b/i.test(value(linkIndex)),
        is_visible: !hidden(row[0]),
        sourceDateText: dateText || null,
        date_posted: /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : null,
      });
    }
  }
  if (!recognized) throw new Error("No supported recruiting table found");
  return rows;
}

export function parseLeadFeed(content: string, options: FeedOptions): FeedResult {
  const result: FeedResult = {
    candidates: [],
    excluded: 0,
    duplicates: 0,
    status: "complete",
    diagnostics: [],
  };
  try {
    if (Buffer.byteLength(content) > 2_000_000) throw new Error("Feed snapshot exceeds 2 MB");
    normalizeLeadUrl(options.sourceUrl);
    const rows: unknown = options.format === "json" ? JSON.parse(content) : htmlRows(content);
    if (!Array.isArray(rows) || rows.length > 10000)
      throw new Error("Expected a bounded JSON listing array");
    const now = options.now ?? new Date();
    const seen = new Set<string>();
    for (const [index, value] of rows.entries()) {
      try {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid row");
        const row = value as Record<string, unknown>;
        if (
          row.active !== true ||
          row.is_visible !== true ||
          !seasonsMatch(text(row.title), row.terms, options) ||
          !text(row.company_name)
        ) {
          result.excluded++;
          continue;
        }
        const postedAt = postedDate(row.date_posted);
        if (
          postedAt &&
          (Date.parse(postedAt) < now.getTime() - options.maxAgeDays * 86_400_000 ||
            Date.parse(postedAt) > now.getTime() + 86_400_000)
        ) {
          result.excluded++;
          continue;
        }
        const originalUrl = text(row.url);
        const candidateDestinationUrl = normalizeLeadUrl(originalUrl);
        if (seen.has(candidateDestinationUrl)) {
          result.duplicates++;
          continue;
        }
        const titleHint = text(row.title);
        if (!titleHint || titleHint.length > 500 || text(row.company_name).length > 300)
          throw new Error("Missing or oversized title/company");
        const sourceRowId = text(row.id) || `row-${index + 1}-${manifestHash(row).slice(0, 24)}`;
        if (sourceRowId.length > 300) throw new Error("Oversized row identity");
        if (result.candidates.length >= 200) {
          result.status = "partial";
          result.excluded++;
          continue;
        }
        seen.add(candidateDestinationUrl);
        result.candidates.push({
          sourceRowId,
          originalUrl,
          candidateDestinationUrl,
          titleHint,
          companyHint: text(row.company_name),
          locationHint: Array.isArray(row.locations)
            ? row.locations
                .filter((item): item is string => typeof item === "string")
                .join("; ")
                .slice(0, 500) || null
            : null,
          postedAt,
          sourceDateText:
            text(row.sourceDateText) || (row.date_posted == null ? null : String(row.date_posted)),
        });
      } catch (error) {
        result.excluded++;
        result.status = "partial";
        if (result.diagnostics.length < 100)
          result.diagnostics.push(
            `Row ${index + 1}: ${error instanceof Error ? error.message : "Invalid row"}`,
          );
      }
    }
    if (result.status === "partial" && result.candidates.length === 200)
      result.diagnostics.push("Feed batch capped at 200 leads");
  } catch (error) {
    result.status = "failed";
    result.diagnostics.push(error instanceof Error ? error.message : "Invalid feed");
  }
  return result;
}
