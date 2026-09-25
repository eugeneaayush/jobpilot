import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type PersonalDigest,
  type PersonalDigestTick,
  personalDigestSchema,
} from "@jobpilot/contracts/personal-digest";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { singleton } from "tsyringe";
import { z } from "zod";
import { conflict } from "@/common/errors";
import { PrismaClient } from "@/generated/prisma/client";
import { objectValue, personalConfiguration, personalRoot, sha256 } from "./runtime";

const scheduleSchema = z.object({
  timezone: z.string().default("America/New_York"),
  hour: z.number().int().min(0).max(23).default(18),
});
const pointerSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function parts(now: Date, timezone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((item) => [item.type, item.value]),
  );
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}
function midnight(day: string, timezone: string): Date {
  const target = Date.parse(`${day}T00:00:00Z`);
  let instant = target;
  for (let i = 0; i < 6; i++) {
    const local = parts(new Date(instant), timezone);
    const observed =
      Date.parse(`${local.day}T00:00:00Z`) +
      local.hour * 3_600_000 +
      local.minute * 60_000 +
      local.second * 1000;
    if (observed === target) return new Date(instant);
    instant += target - observed;
  }
  throw conflict("Digest timezone boundary could not be established");
}
async function safeDirectory(root: string, directory: string, create: boolean) {
  const rootPath = await realpath(root);
  let current = rootPath;
  for (const part of directory.split("/")) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw conflict("Private digest directory is unsafe");
    if (create) await chmod(current, 0o700);
  }
  return current;
}
async function publish(path: string, bytes: string): Promise<boolean> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
async function privateJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 2_000_000)
    throw conflict("Digest artifact failed its privacy or size check");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw conflict("Digest artifact could not be verified");
  }
}
async function readDigest(
  directory: string,
  day: string,
  userId: string,
): Promise<PersonalDigest | null> {
  let pointer: z.infer<typeof pointerSchema>;
  try {
    pointer = pointerSchema.parse(await privateJson(join(directory, `${day}.json`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw conflict("Digest pointer could not be verified");
  }
  if (pointer.day !== day) throw conflict("Digest pointer belongs to another day");
  if (!(await safeDirectory(directory, "snapshots", false)))
    throw conflict("Digest snapshots are unavailable");
  const snapshot = objectValue(
    await privateJson(join(directory, "snapshots", `${pointer.sha256}.json`)),
  );
  if (
    sha256(JSON.stringify(snapshot)) !== pointer.sha256 ||
    snapshot.userId !== userId ||
    snapshot.day !== day
  )
    throw conflict("Digest snapshot failed its integrity check");
  const coverage = objectValue(snapshot.sourceCoverage);
  return personalDigestSchema.parse({
    ...snapshot,
    sha256: pointer.sha256,
    capturedAt: new Date(String(snapshot.capturedAt)),
    windowStartAt: new Date(String(snapshot.windowStartAt)),
    sourceCoverage: {
      ...coverage,
      sources: (coverage.sources as Record<string, unknown>[]).map((source) => ({
        ...source,
        attemptedAt: source.attemptedAt ? new Date(String(source.attemptedAt)) : null,
        completedAt: source.completedAt ? new Date(String(source.completedAt)) : null,
        nextEligibleAt: source.nextEligibleAt ? new Date(String(source.nextEligibleAt)) : null,
      })),
    },
  });
}
const sourceIdentitySchema = z.object({
  source: z.enum(["greenhouse", "lever", "ashby", "cbs"]),
  boardToken: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  region: z.enum(["global", "eu"]).optional(),
});

@singleton()
export class PersonalDigestService {
  constructor(private readonly prisma: PrismaClient) {}

  private async directory(userId: string, create: boolean) {
    if (!z.uuid().safeParse(userId).success) throw conflict("Digest owner identity is invalid");
    return safeDirectory(personalRoot(), `storage/${userId}/digests`, create);
  }
  private async readLatest(userId: string): Promise<PersonalDigest | null> {
    const directory = await this.directory(userId, false);
    if (!directory) return null;
    const days = (await readdir(directory))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .reverse();
    return days[0] ? readDigest(directory, days[0].slice(0, 10), userId) : null;
  }
  async latest(userId: string): Promise<PersonalDigest | null> {
    await personalConfiguration(userId);
    try {
      return await this.readLatest(userId);
    } catch {
      throw conflict("Private digest could not be verified");
    }
  }
  async tick(userId: string, now = new Date()): Promise<PersonalDigestTick> {
    const config = await personalConfiguration(userId);
    try {
      return await this.capture(userId, now, config);
    } catch {
      throw conflict("Local digest could not be captured; no external delivery was attempted");
    }
  }
  private async capture(
    userId: string,
    now: Date,
    config: Record<string, unknown>,
  ): Promise<PersonalDigestTick> {
    if (!Number.isFinite(now.getTime())) throw conflict("Digest clock is invalid");
    let schedule: z.infer<typeof scheduleSchema>;
    try {
      schedule = scheduleSchema.parse(config.digest ?? {});
      parts(now, schedule.timezone);
    } catch {
      throw conflict("Digest schedule is invalid");
    }
    const local = parts(now, schedule.timezone);
    if (local.hour < schedule.hour) return { status: "not_due", digest: null };
    const directory = (await this.directory(userId, true))!;
    const existing = await readDigest(directory, local.day, userId);
    if (existing) return { status: "already_created", digest: existing };
    const previous = await this.readLatest(userId);
    const windowStartAt =
      previous && previous.capturedAt < now
        ? previous.capturedAt
        : midnight(local.day, schedule.timezone);
    const snapshot = await this.snapshot(
      userId,
      now,
      windowStartAt,
      !!previous && previous.capturedAt < now,
      local.day,
      schedule,
    );
    const bytes = JSON.stringify(snapshot);
    const hash = sha256(bytes);
    const snapshots = await safeDirectory(directory, "snapshots", true);
    const artifact = join(snapshots!, `${hash}.json`);
    await publish(artifact, bytes);
    if (sha256(JSON.stringify(await privateJson(artifact))) !== hash)
      throw conflict("Digest snapshot was not durably verified");
    const created = await publish(
      join(directory, `${local.day}.json`),
      JSON.stringify({ day: local.day, sha256: hash }),
    );
    return {
      status: created ? "created" : "already_created",
      digest: await readDigest(directory, local.day, userId),
    };
  }

  private async snapshot(
    userId: string,
    now: Date,
    windowStartAt: Date,
    windowStartExclusive: boolean,
    day: string,
    schedule: z.infer<typeof scheduleSchema>,
  ) {
    const [counts, newDiscoveries, campaigns, sources, records, candidates] =
      await this.prisma.$transaction(
        async (tx) =>
          Promise.all([
            tx.personalRecord.groupBy({ by: ["state"], where: { userId }, _count: { _all: true } }),
            tx.personalRecord.count({
              where: {
                userId,
                createdAt: {
                  ...(windowStartExclusive ? { gt: windowStartAt } : { gte: windowStartAt }),
                  lte: now,
                },
              },
            }),
            tx.campaign.findMany({
              where: {
                userId,
                config: { path: ["personal", "scheduler"], equals: "personal-campaign-v1" },
              },
              take: 1001,
              orderBy: { campaignId: "asc" },
              select: { campaignId: true, query: true, status: true, config: true },
            }),
            tx.personalSource.findMany({
              where: { userId },
              take: 1001,
              orderBy: { identity: "asc" },
            }),
            tx.personalRecord.findMany({
              where: { userId, state: { not: "submitted" } },
              take: 500,
              orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
              select: { id: true, title: true, company: true, state: true, details: true },
            }),
            tx.personalRecord.count({ where: { userId, state: { not: "submitted" } } }),
          ]),
        { isolationLevel: "RepeatableRead", timeout: 15_000 },
      );
    const count = (state: string) => counts.find((item) => item.state === state)?._count._all ?? 0;
    const configured = new Set<string>();
    const stoppedCampaigns: PersonalDigest["stoppedCampaigns"] = [];
    let sourceTruncated = sources.length > 1000;
    for (const campaign of campaigns.slice(0, 1000)) {
      const policy = objectValue(objectValue(campaign.config).personal);
      if (campaign.status !== "in_progress" || policy.enabled !== true)
        stoppedCampaigns.push({
          id: campaign.campaignId,
          name: String(policy.name ?? campaign.query).slice(0, 200),
        });
      const scope = objectValue(policy.sources);
      const instances = Array.isArray(scope.instances) ? [...scope.instances] : [];
      for (const token of Array.isArray(scope.boardTokens) ? scope.boardTokens : [])
        instances.push({ source: "greenhouse", boardToken: token });
      for (const value of instances) {
        const parsed = sourceIdentitySchema.safeParse(value);
        if (!parsed.success || configured.size >= 1000) {
          sourceTruncated = true;
          continue;
        }
        configured.add(personalSourceIdentity(parsed.data));
      }
    }
    const registry = new Map(sources.slice(0, 1000).map((source) => [source.identity, source]));
    const identities = [...new Set([...configured, ...registry.keys()])].sort();
    const coverage: PersonalDigest["sourceCoverage"]["sources"] = identities
      .slice(0, 1000)
      .map((identity) => {
        const source = registry.get(identity);
        const coverage = objectValue(source?.coverage);
        let health: PersonalDigest["sourceCoverage"]["sources"][number]["health"] =
          source?.status ?? "never_attempted";
        if (source?.status === "complete") {
          health = "unknown";
          if (source.completedAt && source.completedAt <= now)
            health =
              now.getTime() - source.completedAt.getTime() > 24 * 3_600_000 ? "stale" : "complete";
        } else if (source?.attemptedAt && !source.status) health = "unknown";
        const number = (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
        let scope: "public_board" | "provided_export" | "unknown" = "unknown";
        if (coverage.scope === "public_board" || coverage.scope === "provided_export")
          scope = coverage.scope;
        else if (identity.startsWith("greenhouse:")) scope = "public_board";
        return {
          identity: identity.slice(0, 300),
          configured: configured.has(identity),
          health,
          attemptedAt: source?.attemptedAt ?? null,
          completedAt: source?.completedAt ?? null,
          nextEligibleAt: source?.nextEligibleAt ?? null,
          observedCount: number(coverage.count ?? coverage.observedTotal),
          expectedTotal: number(coverage.expectedTotal),
          scope,
        };
      });
    const blockers: PersonalDigest["blockers"] = [];
    for (const record of records) {
      const details = objectValue(record.details);
      const kinds: PersonalDigest["blockers"][number]["kinds"] = [];
      if (record.state === "submission_uncertain") kinds.push("reconcile_submission");
      if (
        ["parked", "opening", "open", "resuming", "expired"].includes(
          String(objectValue(details.handoff).status),
        )
      )
        kinds.push("security_handoff");
      if (Array.isArray(details.missingAnswers) && details.missingAnswers.length)
        kinds.push("answers_required");
      if (
        objectValue(details.preview).pdfHash &&
        objectValue(details.preview).renderReviewed !== true
      )
        kinds.push("render_review");
      if (record.state === "blocked" && !kinds.length) kinds.push("review_block");
      if (record.state === "failed") kinds.push("inspect_failure");
      if (kinds.length)
        blockers.push({
          recordId: record.id,
          title: record.title.slice(0, 300),
          company: record.company.slice(0, 300),
          kinds,
        });
    }
    return {
      schemaVersion: 1 as const,
      userId,
      day,
      timezone: schedule.timezone,
      scheduledHour: schedule.hour,
      capturedAt: now,
      windowStartAt,
      windowStartExclusive,
      delivery: "local_only" as const,
      counters: {
        newDiscoveries,
        prepared: count("prepared"),
        submitted: count("submitted"),
        uncertain: count("submission_uncertain"),
        blocked: count("blocked"),
        failed: count("failed"),
      },
      counterBasis:
        "New discoveries were created within the reporting window; remaining counters are current record-state totals, not daily transitions." as const,
      sourceCoverage: {
        sources: coverage,
        truncated: sourceTruncated || identities.length > 1000 || campaigns.length > 1000,
        wholeMarketCoverage: false as const,
        note: "Coverage describes configured boards and provided exports only; complete does not mean the entire job market was searched. Success older than 24 hours is stale.",
      },
      stoppedCampaigns,
      campaignsTruncated: campaigns.length > 1000,
      blockers: blockers.slice(0, 100),
      blockersTruncated: candidates > records.length || blockers.length > 100,
    };
  }
}
