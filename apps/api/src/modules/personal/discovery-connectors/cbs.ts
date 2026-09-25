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
import { parseCsv } from "./csv";
import type { ConnectorPosting } from "./types";

interface CbsImportOptions {
  format: "csv" | "json";
  sourceUrl: string;
  boardToken?: string;
  now?: () => Date;
}

const aliases: Record<string, string> = {
  id: "id",
  jobid: "id",
  nativeid: "id",
  postingid: "id",
  title: "title",
  jobtitle: "title",
  employer: "employer",
  company: "employer",
  companyname: "employer",
  employerid: "employerId",
  companyid: "employerId",
  requisitionid: "requisitionId",
  internaljobid: "internalJobId",
  url: "url",
  joburl: "url",
  postingurl: "url",
  applicationurl: "url",
  description: "description",
  descriptiontext: "description",
  descriptionplain: "description",
  jobdescription: "description",
  descriptionhtml: "descriptionHtml",
  location: "location",
  publishedat: "publishedAt",
  dateposted: "publishedAt",
  firstpublishedat: "firstPublishedAt",
  updatedat: "updatedAt",
  deadline: "deadline",
  applicationdeadline: "deadline",
};
function columnKey(key: string) {
  return key.trim().toLowerCase().replace(/[ _-]/g, "");
}
function mappedRow(raw: Record<string, unknown>) {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const column = columnKey(key);
    const name = Object.hasOwn(aliases, column) ? aliases[column] : undefined;
    if (!name) continue;
    if (Object.hasOwn(mapped, name)) throw new Error(`Duplicate column for ${name}`);
    mapped[name] = value;
  }
  return mapped;
}
function idValue(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return textValue(value);
}
function importRows(input: string, format: CbsImportOptions["format"]) {
  if (format === "json") {
    const parsed: unknown = JSON.parse(input);
    const rows = Array.isArray(parsed) ? parsed : objectValue(parsed).jobs;
    if (!Array.isArray(rows)) throw new Error("JSON import requires an array or {jobs: []}");
    if (rows.length > 5000) throw new Error("JSON exceeds 5000 posting rows");
    return rows.map((raw) => ({ raw, line: null }));
  }
  if (format !== "csv") throw new Error("Unsupported import format");
  const [header, ...rows] = parseCsv(input);
  if (!header) throw new Error("Missing CSV header");
  const headers = header.cells.map((cell) => cell.trim());
  if (headers.some((name) => !name) || new Set(headers.map(columnKey)).size !== headers.length)
    throw new Error("Empty or duplicate CSV header");
  mappedRow(Object.fromEntries(headers.map((name) => [name, ""])));
  const canonical = new Set(headers.map((name) => aliases[columnKey(name)]));
  if (
    !["id", "title", "employer", "url"].every((name) => canonical.has(name)) ||
    !(canonical.has("description") || canonical.has("descriptionHtml"))
  )
    throw new Error("CSV missing required posting columns");
  return rows.map(({ cells, line }) => ({
    raw:
      cells.length === headers.length
        ? Object.fromEntries(headers.map((name, i) => [name, cells[i]]))
        : null,
    line,
  }));
}

export function normalizeCbsImport(input: string, options: CbsImportOptions) {
  const sourceUrl = postingUrl(options.sourceUrl).href;
  const board = boardToken(options.boardToken ?? "cbs");
  const result = createResult(sourceUrl, options, "provided_export");
  try {
    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes > 5_000_000) throw new Error("Import exceeds 5000000 byte limit");
    result.contentHash = sha256(input);
    result.health.receipts.push({
      url: sourceUrl,
      checkedAt: result.health.checkedAt,
      httpStatus: null,
      contentHash: result.contentHash,
      bytes,
    });
    const rows = importRows(input.replace(/^\uFEFF/, ""), options.format);
    result.expectedTotal = rows.length;
    result.coverage.observedTotal = rows.length;
    const seen = new Set<string>();
    for (const [index, source] of rows.entries()) {
      const row = index + 1;
      try {
        const raw = objectValue(source.raw);
        const fields = mappedRow(raw);
        const nativeId = requiredText(idValue(fields.id), "export job ID");
        const plain = textValue(fields.description);
        const html = textValue(fields.descriptionHtml);
        const descriptionHtml = html ?? escapeHtml(requiredText(plain, "full description"));
        const location = textValue(fields.location);
        const publishedAt = sourceDate(fields.publishedAt);
        const posting: ConnectorPosting = {
          source: "cbs",
          boardToken: board,
          sourceRegion: null,
          nativeId,
          employerId: idValue(fields.employerId),
          employer: requiredText(fields.employer, "employer"),
          employerNameSource: "export",
          internalJobId: idValue(fields.internalJobId),
          requisitionId: idValue(fields.requisitionId),
          title: requiredText(fields.title, "title"),
          url: postingUrl(fields.url).href,
          sourceUrl,
          location,
          locations: location ? [location] : [],
          descriptionHtml,
          descriptionText: requiredText(
            plain ?? descriptionText(descriptionHtml),
            "description text",
          ),
          discoveredAt: result.health.checkedAt,
          updatedAt: sourceDate(fields.updatedAt),
          firstPublishedAt: sourceDate(fields.firstPublishedAt),
          publishedAt,
          publishedAtMeaning: publishedAt ? "export_reported" : null,
          deadline: sourceDate(fields.deadline),
          contentHash: sha256(JSON.stringify(raw)),
          raw,
          provenance: { responseHash: result.contentHash, row, line: source.line },
        };
        addPosting(result, seen, posting);
      } catch (error) {
        rowError(result, row, error);
      }
    }
    result.coverage.exhausted = true;
  } catch (error) {
    result.health.lastFailure = "failed";
    result.health.errors.push(error instanceof Error ? error.message : "Invalid import");
  }
  return finishResult(result);
}
