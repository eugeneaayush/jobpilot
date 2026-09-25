import { createHash } from "node:crypto";

export interface DiscoveredPosting {
  source: "greenhouse";
  boardToken: string;
  nativeId: string;
  internalJobId: string | null;
  requisitionId: string | null;
  title: string;
  employer: string;
  url: string;
  sourceUrl: string;
  location: string | null;
  descriptionHtml: string;
  descriptionText: string;
  discoveredAt: string;
  updatedAt: string | null;
  firstPublishedAt: string | null;
  deadline: string | null;
  contentHash: string;
  raw: Record<string, unknown>;
}
export interface DiscoveryResult {
  status: "complete" | "partial" | "failed" | "blocked";
  postings: DiscoveredPosting[];
  sourceUrl: string;
  contentHash: string | null;
  expectedTotal: number | null;
  health: {
    checkedAt: string;
    attempts: number;
    httpStatus: number | null;
    errors: string[];
    nextEligibleAt?: string | null;
  };
}
export interface DiscoveryOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  employer?: string;
  retries?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function decode(s: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return s.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (original, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? original;
      const number =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : original;
    },
  );
}
export function descriptionText(html: string): string {
  let text = html;
  for (let n = 0; n < 3; n++) text = decode(text);
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}
const optionalString = (v: unknown) => (typeof v === "string" ? v : null);

// The public board API documents content=true as including every published post's full description.
export async function discoverGreenhouse(
  boardToken: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(boardToken)) throw new Error("Invalid Greenhouse board token");
  const sourceUrl = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
  const now = options.now ?? (() => new Date());
  const result: DiscoveryResult = {
    status: "failed",
    postings: [],
    sourceUrl,
    contentHash: null,
    expectedTotal: null,
    health: { checkedAt: now().toISOString(), attempts: 0, httpStatus: null, errors: [] },
  };
  const retries = Math.max(0, Math.min(2, Math.floor(options.retries ?? 2)));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    result.health.attempts++;
    try {
      const timeout = AbortSignal.timeout(30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await (options.fetch ?? fetch)(sourceUrl, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { Accept: "application/json" },
      });
      result.health.httpStatus = response.status;
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const at = Number.isFinite(seconds)
            ? now().getTime() + Math.max(0, seconds) * 1000
            : Date.parse(retryAfter);
          if (Number.isFinite(at)) result.health.nextEligibleAt = new Date(at).toISOString();
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          const header = response.headers.get("retry-after");
          const seconds = header ? Number(header) : Number.NaN;
          const wait =
            header && Number.isNaN(seconds) ? Date.parse(header) - now().getTime() : seconds * 1000;
          if (Number.isFinite(wait) && wait > 30_000) {
            result.status = "blocked";
            result.health.errors.push("Retry-After exceeds bounded retry window; retry later");
            return result;
          }
          await sleep(Number.isFinite(wait) ? Math.max(0, wait) : 1000 * 2 ** attempt);
          continue;
        }
        result.status = [401, 403, 429].includes(response.status) ? "blocked" : "failed";
        result.health.errors.push(`HTTP ${response.status}`);
        return result;
      }
      const body = await response.text();
      result.contentHash = sha(body);
      const payload = JSON.parse(body) as { jobs?: unknown; meta?: { total?: unknown } };
      if (!Array.isArray(payload.jobs)) throw new Error("Invalid response: jobs must be an array");
      const total = payload.meta?.total;
      if (typeof total === "number" && Number.isSafeInteger(total) && total >= 0)
        result.expectedTotal = total;
      else result.health.errors.push("Missing or invalid meta.total");
      const seen = new Set<string>();
      for (const raw of payload.jobs) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          result.health.errors.push("Invalid job object");
          continue;
        }
        const j = raw as Record<string, unknown>;
        if (
          !(typeof j.id === "number" && Number.isSafeInteger(j.id) && j.id > 0) ||
          typeof j.title !== "string" ||
          !j.title.trim() ||
          typeof j.absolute_url !== "string" ||
          typeof j.content !== "string"
        ) {
          result.health.errors.push("Job missing valid id, title, URL, or full content");
          continue;
        }
        const nativeId = String(j.id);
        if (seen.has(nativeId)) {
          result.health.errors.push(`Duplicate native ID ${nativeId}`);
          continue;
        }
        let url: URL;
        try {
          url = new URL(j.absolute_url);
        } catch {
          result.health.errors.push(`Invalid job URL ${nativeId}`);
          continue;
        }
        if (!["https:", "http:"].includes(url.protocol)) {
          result.health.errors.push(`Unsafe job URL ${nativeId}`);
          continue;
        }
        seen.add(nativeId);
        const location =
          j.location && typeof j.location === "object"
            ? optionalString((j.location as Record<string, unknown>).name)
            : null;
        result.postings.push({
          source: "greenhouse",
          boardToken,
          nativeId,
          internalJobId:
            typeof j.internal_job_id === "number" &&
            Number.isSafeInteger(j.internal_job_id) &&
            j.internal_job_id > 0
              ? String(j.internal_job_id)
              : null,
          requisitionId: optionalString(j.requisition_id)?.trim() || null,
          title: j.title,
          employer: optionalString(j.company_name) ?? options.employer ?? boardToken,
          url: j.absolute_url,
          sourceUrl,
          location,
          descriptionHtml: j.content,
          descriptionText: descriptionText(j.content),
          discoveredAt: result.health.checkedAt,
          updatedAt: optionalString(j.updated_at),
          firstPublishedAt: optionalString(j.first_published),
          deadline: optionalString(j.application_deadline),
          contentHash: sha(JSON.stringify(j)),
          raw: j,
        });
      }
      if (result.expectedTotal !== result.postings.length)
        result.health.errors.push("Post count does not match declared total");
      result.status = result.health.errors.length ? "partial" : "complete";
      return result;
    } catch (error) {
      if (options.signal?.aborted || attempt === retries) {
        result.health.errors.push(error instanceof Error ? error.message : "Discovery failed");
        return result;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
  return result;
}
