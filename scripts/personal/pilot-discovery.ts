import { createHash } from "node:crypto";
import type { PersonalCampaign } from "../../packages/contracts/src/personal-campaign";
import {
  personalRegisteredSourceSchema,
  personalRegistrySourceSchema,
} from "../../packages/contracts/src/personal-registry";
import {
  personalSearchResponseSchema,
  personalSearchSchema,
} from "../../packages/contracts/src/personal-search";
import { personalSourceIdentity } from "../../packages/contracts/src/personal-source";
import { LocalHttpError } from "./common";
import {
  beginDiscovery,
  delayRequest,
  finishDiscovery,
  type PollingState,
  requestBucket,
  sourcePoll,
} from "./polling";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface PilotDiscoveryConfig {
  queries?: { campaignId: string; query: string; maxPages?: number; pageSize?: number }[];
}
type Source = typeof personalRegisteredSourceSchema._output;
type SearchSummary = Pick<
  typeof personalSearchResponseSchema._output,
  "status" | "queryHash" | "coverage" | "budget"
>;
export interface PilotDiscoveryState {
  registry?: {
    page: number;
    nextEligibleAt: number;
    status?: "complete" | "partial" | "failed";
    sources: Record<string, { configuration: Source | null; nextEligibleAt: number }>;
  };
  queries?: Record<
    string,
    {
      attemptedAt: number;
      nextEligibleAt: number;
      status: SearchSummary["status"] | "uncertain";
      summary?: SearchSummary;
    }
  >;
  sourceCursor?: string;
  queryCursor?: string;
  searchNextEligibleAt?: number;
  lastAction?: "source" | "search";
  lastHold?: string;
}
interface Dependencies {
  api: (route: string, body?: unknown) => Promise<unknown>;
  persist: () => Promise<void>;
  now?: () => number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid discovery API object");
  return value as Record<string, unknown>;
}
const date = (value: unknown) =>
  value === null
    ? null
    : new Date(typeof value === "string" || typeof value === "number" ? value : NaN);
function pageResult(raw: unknown, key: "sources" | "items", page: number) {
  const value = object(raw);
  const pagination = object(value.pagination);
  const rows = value[key];
  if (
    !Array.isArray(rows) ||
    rows.length > 100 ||
    pagination.page !== page ||
    pagination.limit !== 100 ||
    typeof pagination.total !== "number" ||
    !Number.isInteger(pagination.total) ||
    pagination.total < 0 ||
    typeof pagination.totalPages !== "number" ||
    pagination.totalPages !== Math.ceil(pagination.total / 100)
  )
    throw new Error("Invalid discovery API pagination");
  return { rows: rows as unknown[], totalPages: pagination.totalPages };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const eligible = (campaign: PersonalCampaign) =>
  campaign.status === "active" &&
  uuid.test(campaign.id) &&
  uuid.test(campaign.authorization?.runId ?? "");
function configuredSources(campaign: PersonalCampaign) {
  const result = new Map<string, Source>();
  const sources = [
    ...(campaign.sources?.boardTokens ?? []).map((boardToken) => ({
      source: "greenhouse",
      boardToken,
    })),
    ...(campaign.sources?.instances ?? []),
  ];
  for (const item of sources) {
    const parsed = personalRegisteredSourceSchema.safeParse(item);
    if (!parsed.success || parsed.data.source === "cbs") continue;
    const source =
      parsed.data.source === "lever"
        ? { ...parsed.data, region: parsed.data.region ?? ("global" as const) }
        : parsed.data;
    result.set(personalSourceIdentity(source), source);
  }
  return result;
}
function dueKey(keys: string[], cursor?: string) {
  const sorted = keys.sort();
  return sorted.find((key) => !cursor || key > cursor) ?? sorted[0];
}
function retryAt(error: unknown, fallback: number) {
  return error instanceof LocalHttpError ? Math.max(fallback, error.retryAt ?? 0) : fallback;
}
function cooling(polling: PollingState, method: string, route: string, now: number) {
  return now < (polling.cooldowns[requestBucket("api", method, route)] ?? 0);
}
function rememberCooldown(
  polling: PollingState,
  method: string,
  route: string,
  error: unknown,
  now: number,
) {
  if (
    error instanceof LocalHttpError &&
    error.retryScope !== "source" &&
    (error.status === 429 || error.retryAt !== undefined)
  )
    delayRequest(polling, requestBucket("api", method, route), retryAt(error, now + MINUTE));
}
async function registry(
  state: PilotDiscoveryState,
  polling: PollingState,
  keys: Set<string>,
  deps: Dependencies,
  now: number,
) {
  state.registry ??= { page: 1, nextEligibleAt: 0, sources: {} };
  const saved = state.registry;
  for (const key of Object.keys(saved.sources)) if (!keys.has(key)) delete saved.sources[key];
  if (now < saved.nextEligibleAt || cooling(polling, "GET", "/personal/registry", now)) return;
  const page = saved.page;
  saved.nextEligibleAt = now + MINUTE;
  await deps.persist();
  try {
    const response = pageResult(
      await deps.api(`/personal/registry?page=${page}&limit=100`),
      "sources",
      page,
    );
    if (response.totalPages > 100)
      throw new Error("Registry pagination is outside the bounded scan");
    for (const raw of response.rows) {
      const entry = object(raw);
      const row = personalRegistrySourceSchema.parse({
        ...entry,
        attemptedAt: date(entry.attemptedAt),
        lastSuccessfulAt: date(entry.lastSuccessfulAt),
        nextEligibleAt: date(entry.nextEligibleAt),
        updatedAt: date(entry.updatedAt),
      });
      if (!keys.has(row.identity)) continue;
      const valid =
        row.configurationState === "valid" &&
        row.configuration &&
        personalSourceIdentity(row.configuration) === row.identity &&
        row.adapter.discovery === "public_api";
      saved.sources[row.identity] = {
        configuration: valid ? row.configuration : null,
        nextEligibleAt: row.nextEligibleAt?.getTime() ?? 0,
      };
      const poll = sourcePoll(polling, row.identity);
      poll.nextAttemptAt = Math.max(
        poll.nextAttemptAt,
        row.nextEligibleAt?.getTime() ?? 0,
        row.lastSuccessfulAt ? row.lastSuccessfulAt.getTime() + HOUR : 0,
      );
      if (row.lastSuccessfulAt)
        poll.succeededAt = Math.max(poll.succeededAt ?? 0, row.lastSuccessfulAt.getTime());
    }
    const complete = page >= response.totalPages;
    saved.page = complete ? 1 : page + 1;
    saved.status = complete ? "complete" : "partial";
    saved.nextEligibleAt = now + (complete ? 5 * MINUTE : MINUTE);
  } catch (error) {
    rememberCooldown(polling, "GET", "/personal/registry", error, now);
    saved.status = "failed";
    saved.nextEligibleAt = retryAt(error, now + 5 * MINUTE);
  }
  await deps.persist();
}
async function stillAuthorized(
  campaigns: PersonalCampaign[],
  sourceKey: string | undefined,
  deps: Dependencies,
  polling: PollingState,
  now: number,
) {
  if (cooling(polling, "GET", "/personal/campaigns", now)) return undefined;
  const expected = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  for (let page = 1; page <= 5; page++) {
    const raw = await deps.api(`/personal/campaigns?status=active&page=${page}&limit=100`);
    const parsed = pageResult(raw, "items", page);
    for (const item of parsed.rows) {
      if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string")
        continue;
      const campaign = expected.get(item.id);
      if (!campaign) continue;
      const current = item as PersonalCampaign;
      if (
        eligible(current) &&
        current.authorization?.runId === campaign.authorization?.runId &&
        (!sourceKey || configuredSources(current).has(sourceKey))
      )
        return { campaignId: current.id, runId: current.authorization!.runId };
    }
    if (page >= parsed.totalPages) return undefined;
  }
  return undefined;
}

/** One provider action per minute; API endpoints retain authoritative source and spend reservations. */
export async function tickPilotDiscovery(
  state: PilotDiscoveryState,
  polling: PollingState,
  campaigns: PersonalCampaign[],
  configuration: PilotDiscoveryConfig,
  deps: Dependencies,
): Promise<void> {
  if (
    Object.keys(configuration).some((key) => key !== "queries") ||
    (configuration.queries !== undefined &&
      (!Array.isArray(configuration.queries) || configuration.queries.length > 100))
  )
    throw new Error("Invalid pilot discovery configuration");
  const config = {
    queries: (configuration.queries ?? []).map(({ campaignId, ...input }) => {
      if (!uuid.test(campaignId))
        throw new Error("Search query requires a configured campaign UUID");
      return { campaignId, ...personalSearchSchema.parse(input) };
    }),
  };
  const active = campaigns.filter(eligible);
  if (!active.length) return;
  const now = (deps.now ?? Date.now)();
  const sources = new Map<string, { source: Source; campaigns: PersonalCampaign[] }>();
  for (const campaign of active)
    for (const [key, source] of configuredSources(campaign)) {
      const existing = sources.get(key);
      if (existing) existing.campaigns.push(campaign);
      else sources.set(key, { source, campaigns: [campaign] });
    }
  if (sources.size > 1000) {
    state.lastHold = "configured_source_limit_exceeded";
    await deps.persist();
    return;
  }
  state.queries ??= {};
  const configured = new Set(config.queries.map((query) => sha(query.query)));
  for (const key of Object.keys(state.queries)) if (!configured.has(key)) delete state.queries[key];
  await registry(state, polling, new Set(sources.keys()), deps, now);
  if (now < (polling.discoveryNextAt ?? 0)) return;
  const sourceKey = cooling(polling, "POST", "/personal/discover", now)
    ? undefined
    : dueKey(
        [...sources.keys()].filter(
          (key) =>
            now >= sourcePoll(polling, key).nextAttemptAt &&
            state.registry?.sources[key]?.configuration !== null,
        ),
        state.sourceCursor,
      );
  const queries = new Map<
    string,
    { input: typeof personalSearchSchema._output; campaigns: PersonalCampaign[] }
  >();
  for (const { campaignId, ...input } of config.queries) {
    const campaign = active.find((item) => item.id === campaignId);
    if (!campaign) continue;
    const key = sha(input.query);
    const existing = queries.get(key);
    if (existing) existing.campaigns.push(campaign);
    else queries.set(key, { input, campaigns: [campaign] });
  }
  const queryKey =
    now < (state.searchNextEligibleAt ?? 0) || cooling(polling, "POST", "/personal/search", now)
      ? undefined
      : dueKey(
          [...queries.keys()].filter((key) => now >= (state.queries![key]?.nextEligibleAt ?? 0)),
          state.queryCursor,
        );
  const search = !!queryKey && (!sourceKey || state.lastAction === "source");
  const key = search ? queryKey : sourceKey;
  if (!key) return;
  polling.discoveryNextAt = now + MINUTE;
  await deps.persist();
  const candidates = search ? queries.get(key)!.campaigns : sources.get(key)!.campaigns;
  let authorized: { campaignId: string; runId: string } | undefined;
  try {
    authorized = await stillAuthorized(candidates, search ? undefined : key, deps, polling, now);
  } catch (error) {
    rememberCooldown(polling, "GET", "/personal/campaigns", error, now);
  }
  if (!authorized) {
    state.lastHold = "campaign_authorization_unavailable_or_changed";
    await deps.persist();
    return;
  }
  delete state.lastHold;
  if (!search) {
    const poll = sourcePoll(polling, key);
    beginDiscovery(poll, now);
    state.sourceCursor = key;
    state.lastAction = "source";
    await deps.persist();
    try {
      const source = state.registry?.sources[key]?.configuration ?? sources.get(key)!.source;
      const raw = object(await deps.api("/personal/discover", { ...source, ...authorized }));
      if (
        typeof raw.status !== "string" ||
        !["complete", "partial", "failed", "blocked"].includes(raw.status) ||
        (raw.nextEligibleAt !== undefined &&
          (typeof raw.nextEligibleAt !== "string" ||
            !Number.isFinite(Date.parse(raw.nextEligibleAt))))
      )
        throw new Error("Invalid source discovery result");
      const result = {
        status: raw.status,
        ...(typeof raw.nextEligibleAt === "string" && { nextEligibleAt: raw.nextEligibleAt }),
      };
      finishDiscovery(poll, result, (deps.now ?? Date.now)());
    } catch (error) {
      rememberCooldown(polling, "POST", "/personal/discover", error, now);
      finishDiscovery(poll, { status: "failed" }, (deps.now ?? Date.now)(), retryAt(error, 0));
    }
  } else {
    state.queryCursor = key;
    state.lastAction = "search";
    const query: NonNullable<PilotDiscoveryState["queries"]>[string] = {
      attemptedAt: now,
      nextEligibleAt: now + DAY,
      status: "uncertain",
    };
    state.queries[key] = query;
    await deps.persist();
    try {
      const raw = object(
        await deps.api("/personal/search", { ...queries.get(key)!.input, ...authorized }),
      );
      const result = personalSearchResponseSchema.parse({
        ...raw,
        nextEligibleAt: date(raw.nextEligibleAt),
        receipts: Array.isArray(raw.receipts)
          ? raw.receipts.map((value: unknown) => {
              const receipt = object(value);
              return { ...receipt, nextEligibleAt: date(receipt.nextEligibleAt) };
            })
          : raw.receipts,
      });
      if (result.queryHash !== key) throw new Error("Search query hash changed");
      query.status = result.status;
      state.queries[key] = {
        ...query,
        summary: {
          status: result.status,
          queryHash: result.queryHash,
          coverage: result.coverage,
          budget: result.budget,
        },
      };
      const serverNext = result.nextEligibleAt?.getTime() ?? 0;
      state.queries[key]!.nextEligibleAt = Math.max(now + DAY, serverNext);
      state.searchNextEligibleAt = Math.max(state.searchNextEligibleAt ?? 0, serverNext);
      if (["budget_exhausted", "cooldown", "missing_setup", "blocked"].includes(result.status))
        state.searchNextEligibleAt = Math.max(state.searchNextEligibleAt, serverNext || now + DAY);
    } catch (error) {
      rememberCooldown(polling, "POST", "/personal/search", error, now);
      state.searchNextEligibleAt = retryAt(error, now + HOUR);
    }
  }
  await deps.persist();
}
