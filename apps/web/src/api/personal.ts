import type { PaginationQuery } from "@jobpilot/contracts/pagination";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import type { PersonalCampaign } from "@jobpilot/contracts/personal-campaign";
import { API_BASE_URL } from "@/api/base-url";
import { api } from "@/api/client";

/** The contract exports DTO types only; track/state come off the record. */
type PersonalTrack = PersonalRecordDto["track"];

/**
 * The API issues relative URLs (e.g. preview.pdfUrl → "/api/personal/:id/pdf"); the web app
 * proxies nothing, so browser-facing links must be pinned to the API origin explicitly.
 */
export function absoluteApiUrl(url: string): string {
  return url.startsWith("http") ? url : `${API_BASE_URL}${url}`;
}

/**
 * Query keys for the private personal dashboard. Scoped here rather than in
 * `@/api/query-keys`: the whole personal surface ships and invalidates together.
 */
export const personalQueryKeys = {
  all: ["personal"] as const,
  dashboard: (filters: Record<string, unknown> = {}) =>
    [...personalQueryKeys.all, "dashboard", filters] as const,
  settings: () => [...personalQueryKeys.all, "settings"] as const,
  approval: (recordId: string) => [...personalQueryKeys.all, "approval", recordId] as const,
  campaigns: (filters: Record<string, unknown> = {}) =>
    [...personalQueryKeys.all, "campaigns", filters] as const,
  readiness: () => [...personalQueryKeys.all, "readiness"] as const,
  screeningAnswers: (recordId: string) =>
    [...personalQueryKeys.all, "readiness", "answers", recordId] as const,
  recovery: (recordId: string, targetCampaignId?: string) =>
    [...personalQueryKeys.all, "recovery", recordId, targetCampaignId ?? "original"] as const,
  handoff: (attemptId: string) => [...personalQueryKeys.all, "handoff", attemptId] as const,
  attachments: (recordId: string) => [...personalQueryKeys.all, "attachments", recordId] as const,
  challenge: (attemptId: string) => [...personalQueryKeys.all, "challenge", attemptId] as const,
  registry: (filters: Record<string, unknown> = {}) =>
    [...personalQueryKeys.all, "registry", filters] as const,
  aliases: (filters: Record<string, unknown> = {}) =>
    [...personalQueryKeys.all, "aliases", filters] as const,
  policy: () => [...personalQueryKeys.all, "policy"] as const,
  digest: () => [...personalQueryKeys.all, "digest", "latest"] as const,
  recruiting: () => [...personalQueryKeys.all, "recruiting"] as const,
};

interface PersonalDashboardQuery extends PaginationQuery {
  track?: PersonalTrack;
}

interface PersonalCampaignListQuery extends PaginationQuery {
  status?: PersonalCampaign["status"];
}

/** Per-endpoint query defs against the routes in docs/private-jobpilot-work.md. */
export const personalQueries = {
  approval: (recordId: string) => ({
    queryKey: personalQueryKeys.approval(recordId),
    queryFn: () => api.personal.approvals.records({ id: recordId }).get(),
  }),
  recruiting: () => ({
    queryKey: personalQueryKeys.recruiting(),
    queryFn: () => api.personal.recruiting.get(),
  }),
  dashboard: (query: PersonalDashboardQuery) => ({
    queryKey: personalQueryKeys.dashboard({ ...query }),
    queryFn: () => api.personal.get({ query }),
  }),
  settings: () => ({
    queryKey: personalQueryKeys.settings(),
    queryFn: () => api.personal.settings.get(),
  }),
  campaigns: (query: PersonalCampaignListQuery = { page: 1, limit: 10 }) => ({
    queryKey: personalQueryKeys.campaigns({ ...query }),
    queryFn: () => api.personal.campaigns.get({ query }),
  }),
  readiness: () => ({
    queryKey: personalQueryKeys.readiness(),
    queryFn: () => api.personal.readiness.get(),
  }),
  screeningAnswers: (recordId: string) => ({
    queryKey: personalQueryKeys.screeningAnswers(recordId),
    queryFn: () => api.personal.readiness.records({ id: recordId }).answers.get(),
  }),
  recovery: (recordId: string, targetCampaignId?: string) => ({
    queryKey: personalQueryKeys.recovery(recordId, targetCampaignId),
    queryFn: () =>
      // No target → no query param: the request stays identical to the pre-transfer API.
      targetCampaignId === undefined
        ? api.personal.recovery.records({ id: recordId }).get()
        : api.personal.recovery.records({ id: recordId }).get({
            query: { targetCampaignId },
          }),
  }),
  handoff: (attemptId: string) => ({
    queryKey: personalQueryKeys.handoff(attemptId),
    queryFn: () => api.personal.attempts({ id: attemptId }).handoff.get(),
  }),
  attachments: (recordId: string) => ({
    queryKey: personalQueryKeys.attachments(recordId),
    queryFn: () => api.personal.attachments({ id: recordId }).get(),
  }),
  challenge: (attemptId: string) => ({
    queryKey: personalQueryKeys.challenge(attemptId),
    queryFn: () => api.personal.attempts({ id: attemptId }).challenge.get(),
  }),
  registry: (query: PaginationQuery = { page: 1, limit: 25 }) => ({
    queryKey: personalQueryKeys.registry({ ...query }),
    queryFn: () => api.personal.registry.get({ query }),
  }),
  aliases: (query: PaginationQuery = { page: 1, limit: 25 }) => ({
    queryKey: personalQueryKeys.aliases({ ...query }),
    queryFn: () => api.personal.aliases.get({ query }),
  }),
  policy: () => ({
    queryKey: personalQueryKeys.policy(),
    queryFn: () => api.personal.policy.get(),
  }),
  digest: () => ({
    queryKey: personalQueryKeys.digest(),
    queryFn: () => api.personal.digest.latest.get(),
  }),
};
