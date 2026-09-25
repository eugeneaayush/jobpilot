interface IdlePoll {
  idleCount: number;
  nextAt: number;
}
interface DiscoveryPoll {
  attemptedAt?: number;
  succeededAt?: number;
  nextAttemptAt: number;
  failures: number;
  outcome?: "complete" | "partial" | "failed" | "blocked";
}
export interface PollingState {
  list?: IdlePoll;
  campaigns: Record<string, IdlePoll>;
  cooldowns: Record<string, number>;
  discoveries: Record<string, DiscoveryPoll>;
  preparations: Record<string, { attemptedAt: number; page: number }>;
  discoveryNextAt?: number;
  preparationNextAt?: number;
  scheduleNextAt?: number;
}
export function newPollingState(): PollingState {
  return { campaigns: {}, cooldowns: {}, discoveries: {}, preparations: {} };
}
export function idlePoll(previous: IdlePoll | undefined, now = Date.now()): IdlePoll {
  const idleCount = Math.min(6, (previous?.idleCount ?? 0) + 1);
  return { idleCount, nextAt: now + Math.min(300_000, 15_000 * 2 ** (idleCount - 1)) };
}
export function requestBucket(service: "api" | "terminal", method: string, route: string): string {
  const clean = route
    .split("?")[0]!
    .replace(/\/personal\/attempts\/[^/]+/, "/personal/attempts/:id")
    .replace(/\/personal\/campaigns\/[^/]+/, "/personal/campaigns/:id")
    .replace(
      /^\/personal\/[^/]+\/(preview|tailoring|preparation|pdf|render-review)$/,
      "/personal/:id/$1",
    )
    .replace(/^\/tasks\/[^/]+/, "/tasks/:id");
  return `${service}:${method}:${clean}`;
}
class PollingCooldownError extends Error {
  constructor(
    readonly bucket: string,
    readonly retryAt: number,
  ) {
    super(`Local request cooldown remains active until ${new Date(retryAt).toISOString()}`);
  }
}
export function checkCooldown(polling: PollingState, bucket: string, now = Date.now()): void {
  const until = polling.cooldowns[bucket] ?? 0;
  if (until > now) throw new PollingCooldownError(bucket, until);
  delete polling.cooldowns[bucket];
}
export function delayRequest(polling: PollingState, bucket: string, until: number): void {
  polling.cooldowns[bucket] = Math.max(polling.cooldowns[bucket] ?? 0, until);
}
export function sourcePoll(
  polling: PollingState,
  source: string,
  legacyAttempt?: number,
): DiscoveryPoll {
  // Old timestamps recorded attempts before HTTP completed; never migrate them as success.
  polling.discoveries[source] ??= {
    ...(legacyAttempt === undefined ? {} : { attemptedAt: legacyAttempt }),
    nextAttemptAt: legacyAttempt === undefined ? 0 : legacyAttempt + 3_600_000,
    failures: 0,
  };
  return polling.discoveries[source];
}
export function beginDiscovery(source: DiscoveryPoll, now = Date.now()): void {
  source.attemptedAt = now;
  source.nextAttemptAt = now + 3_600_000; // A crash cannot turn a started request into an immediate retry.
}
export function finishDiscovery(
  source: DiscoveryPoll,
  result: { status?: string; nextEligibleAt?: string },
  now = Date.now(),
  retryAt = 0,
): void {
  const success = result.status === "complete";
  source.outcome = "failed";
  if (success) source.outcome = "complete";
  else if (result.status === "partial" || result.status === "blocked")
    source.outcome = result.status;
  source.failures = success ? 0 : Math.min(7, source.failures + 1);
  if (success) source.succeededAt = now;
  const serverNext = result.nextEligibleAt ? Date.parse(result.nextEligibleAt) : 0;
  source.nextAttemptAt = Math.max(
    now + (success ? 3_600_000 : Math.min(3_600_000, 60_000 * 2 ** (source.failures - 1))),
    Number.isFinite(serverNext) ? serverNext : 0,
    retryAt,
  );
}
