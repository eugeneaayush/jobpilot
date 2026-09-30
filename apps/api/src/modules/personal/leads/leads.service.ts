import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pageSlice, paginate } from "@jobpilot/contracts/pagination";
import {
  type PersonalLead,
  type PersonalLeadCandidate,
  personalLeadDiscoverSchema,
  personalLeadFeedImportSchema,
  personalLeadImportSchema,
  personalLeadQuerySchema,
  personalLeadResolveSchema,
  personalLeadSchema,
} from "@jobpilot/contracts/personal-leads";
import type { PersonalSearchResponse } from "@jobpilot/contracts/personal-search";
import { singleton } from "tsyringe";
import type { z } from "zod";
import { badRequest, conflict, notFound } from "@/common/errors";
import { type PersonalDiscoveryRun, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { PersonalDiscoveryService } from "../discovery.service";
import { runLocalTool } from "../local-tools/runner";
import { manifestHash } from "../persistence-policy";
import { jsonValue, objectValue, personalConfiguration, personalRoot } from "../runtime";
import { parseLeadFeed } from "./feed-parser";
import { normalizeLeadUrl, officialLeadDestination, sourceEnabled } from "./lead-policy";
import { authorizeLeadDestination, resolvedLeadRecord } from "./lead-resolution";

function leadResponse(row: PersonalDiscoveryRun): PersonalLead {
  const lead = objectValue(objectValue(row.details).lead);
  const resolution = objectValue(lead.resolution);
  return personalLeadSchema.parse({
    ...lead,
    id: row.id,
    discoveredAt: new Date(String(lead.discoveredAt)),
    postedAt: lead.postedAt ? new Date(String(lead.postedAt)) : null,
    resolution: {
      ...resolution,
      resolvedAt: resolution.resolvedAt ? new Date(String(resolution.resolvedAt)) : null,
    },
  });
}
interface BatchInput {
  source: PersonalLead["source"];
  candidates: PersonalLeadCandidate[];
  snapshot: string | Uint8Array;
  status: "complete" | "partial" | "blocked" | "failed";
  diagnostics?: string[];
  excluded?: number;
  duplicates?: number;
  nextEligibleAt?: Date | null;
  metadata?: Record<string, unknown>;
}

@singleton()
export class PersonalLeadsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly discovery: PersonalDiscoveryService,
  ) {}

  async list(userId: string, query: z.infer<typeof personalLeadQuerySchema>) {
    await personalConfiguration(userId);
    const where: Prisma.PersonalDiscoveryRunWhereInput = {
      userId,
      source: query.source ? `lead:${query.source}` : { startsWith: "lead:" },
      ...(query.status
        ? { details: { path: ["lead", "resolution", "status"], equals: query.status } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.personalDiscoveryRun.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...pageSlice(query),
      }),
      this.prisma.personalDiscoveryRun.count({ where }),
    ]);
    return paginate(rows.map(leadResponse), query, total);
  }

  async import(userId: string, input: z.infer<typeof personalLeadImportSchema>) {
    await personalConfiguration(userId);
    const parsed = personalLeadImportSchema.parse(input);
    return this.saveBatch(userId, {
      source: "manual",
      candidates: parsed.candidates,
      snapshot: JSON.stringify(parsed),
      status: "complete",
    });
  }

  async importBrave(userId: string, result: PersonalSearchResponse) {
    await personalConfiguration(userId);
    const status = {
      complete: "complete",
      partial: "partial",
      failed: "failed",
      blocked: "blocked",
      missing_setup: "blocked",
      budget_exhausted: "blocked",
      cooldown: "blocked",
    }[result.status] as BatchInput["status"];
    return this.saveBatch(userId, {
      source: "brave",
      status,
      snapshot: JSON.stringify(result),
      diagnostics: result.reasons,
      candidates: result.candidates.slice(0, 200).map((candidate) => ({
        sourceRowId: candidate.urlHash,
        originalUrl: candidate.url,
        candidateDestinationUrl: candidate.url,
        titleHint: candidate.title.slice(0, 500) || "Career URL candidate",
        companyHint: null,
        locationHint: null,
        postedAt: null,
        sourceDateText: null,
      })),
      metadata: { queryHash: result.queryHash, receipts: result.receipts },
    });
  }

  async importFeed(userId: string, input: z.infer<typeof personalLeadFeedImportSchema>) {
    const config = await personalConfiguration(userId);
    const parsed = personalLeadFeedImportSchema.parse(input);
    if (!sourceEnabled(config.leadDiscovery, "feeds", parsed.feed))
      throw conflict("This optional feed is disabled in private runtime configuration");
    const result = parseLeadFeed(parsed.content, parsed);
    return this.saveBatch(userId, {
      source: parsed.feed,
      ...result,
      snapshot: parsed.content,
      metadata: {
        sourceUrl: parsed.sourceUrl,
        seasonYear: parsed.seasonYear,
        season: parsed.season,
        maxAgeDays: parsed.maxAgeDays,
      },
    });
  }

  async discover(userId: string, input: z.infer<typeof personalLeadDiscoverSchema>) {
    const config = await personalConfiguration(userId);
    const parsed = personalLeadDiscoverSchema.parse(input);
    if (!sourceEnabled(config.leadDiscovery, "boards", parsed.board))
      throw conflict("This optional board is disabled in private runtime configuration");
    const request = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const recent = await tx.personalDiscoveryRun.findMany({
        where: {
          userId,
          source: { startsWith: "lead_request:" },
          createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) },
        },
        orderBy: { createdAt: "desc" },
      });
      if (
        recent.some((row) => {
          const details = objectValue(row.details);
          return (
            Date.parse(String(details.nextEligibleAt)) > Date.now() &&
            (row.source === `lead_request:${parsed.board}` || details.running === true)
          );
        })
      )
        throw conflict("Lead discovery is running or this board's cooldown is active");
      return tx.personalDiscoveryRun.create({
        data: {
          userId,
          source: `lead_request:${parsed.board}`,
          status: "partial",
          details: jsonValue({
            running: true,
            queryHash: manifestHash(parsed),
            nextEligibleAt: new Date(Date.now() + 180_000).toISOString(),
          }),
        },
      });
    });
    try {
      const output = await runLocalTool(userId, "discover_jobs", parsed);
      const result = output.result;
      const status = {
        complete: "complete",
        empty: "complete",
        partial: "partial",
        blocked: "blocked",
        error: "failed",
      } as const;
      const nextEligibleAt = new Date(
        Date.now() + Math.max(60, Math.min(604800, result.cooldownSeconds ?? 3600)) * 1000,
      );
      const snapshot = result.snapshotFilename
        ? output.artifacts[result.snapshotFilename]
        : undefined;
      if (result.snapshotFilename && !snapshot) throw conflict("Discovery snapshot is missing");
      const batch = await this.saveBatch(userId, {
        source: parsed.board,
        status: status[result.status],
        nextEligibleAt,
        snapshot: snapshot ?? JSON.stringify(result),
        diagnostics: result.diagnostics.map((item) => `${item.code}: ${item.message}`),
        candidates: result.leads.map((lead) => ({
          sourceRowId: lead.sourceRowId,
          originalUrl: lead.originalUrl,
          candidateDestinationUrl: lead.candidateDestinationUrl,
          titleHint: lead.titleHint,
          companyHint: lead.companyHint,
          locationHint: lead.locationHint,
          postedAt:
            lead.postedAt && Number.isFinite(Date.parse(lead.postedAt))
              ? new Date(lead.postedAt).toISOString()
              : null,
          sourceDateText: lead.postedAt,
        })),
        metadata: {
          requestId: request.id,
          queryHash: manifestHash(parsed),
          responseHash: result.responseSha256,
          sourceStatus: result.status,
        },
      });
      await this.prisma.personalDiscoveryRun.update({
        where: { id: request.id },
        data: {
          status: status[result.status],
          details: jsonValue({ running: false, batchId: batch.batchId, nextEligibleAt }),
        },
      });
      return batch;
    } catch (error) {
      await this.prisma.personalDiscoveryRun.update({
        where: { id: request.id },
        data: {
          status: "failed",
          details: jsonValue({
            running: false,
            reason: "local_discovery_failed",
            nextEligibleAt: new Date(Date.now() + 3600_000),
          }),
        },
      });
      throw error;
    }
  }

  async resolve(userId: string, id: string, input: z.infer<typeof personalLeadResolveSchema>) {
    await personalConfiguration(userId);
    const parsed = personalLeadResolveSchema.parse(input);
    const claim = randomUUID();
    const pending = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const row = await tx.personalDiscoveryRun.findFirst({
        where: { id, userId, source: { startsWith: "lead:" } },
      });
      if (!row) throw notFound("Lead not found");
      const lead = leadResponse(row);
      const details = objectValue(row.details);
      if (lead.resolution.status === "resolved")
        throw conflict(
          "This lead is already resolved; refresh the official posting through discovery",
        );
      if (
        lead.resolution.status === "resolving" &&
        Date.parse(String(details.claimExpiresAt)) > Date.now()
      )
        throw conflict("This lead is already being resolved");
      let destination: ReturnType<typeof officialLeadDestination>;
      try {
        destination = officialLeadDestination(
          parsed.officialUrl ?? lead.candidateDestinationUrl ?? lead.originalUrl,
        );
      } catch (error) {
        throw badRequest(
          error instanceof Error ? error.message : "Unsupported official destination",
        );
      }
      const authorized = await authorizeLeadDestination(tx, userId, parsed, destination);
      const resolution = {
        ...lead.resolution,
        status: "resolving",
        officialUrl: destination.url,
        sourceIdentity: destination.sourceIdentity,
        reason: null,
      };
      await tx.personalDiscoveryRun.update({
        where: { id },
        data: {
          details: jsonValue({
            ...details,
            claim,
            claimExpiresAt: new Date(Date.now() + 10 * 60_000),
            lead: { ...lead, resolution },
          }),
        },
      });
      return { destination, configuration: authorized.configuration };
    });
    try {
      const discovered = await this.discovery.discover(userId, {
        ...pending.configuration,
        ...parsed,
      });
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        await authorizeLeadDestination(tx, userId, parsed, pending.destination);
        const row = await tx.personalDiscoveryRun.findFirst({ where: { id, userId } });
        if (!row || objectValue(row.details).claim !== claim)
          throw conflict("Lead resolution claim changed");
        const record = await tx.personalRecord.findFirst({
          where: { userId, identity: pending.destination.identity },
        });
        const recordId = resolvedLeadRecord(record, pending.destination, discovered.runId);
        const lead = leadResponse(row);
        const saved = await tx.personalDiscoveryRun.update({
          where: { id },
          data: {
            details: jsonValue({
              ...objectValue(row.details),
              claim: null,
              claimExpiresAt: null,
              lead: {
                ...lead,
                resolution: {
                  ...lead.resolution,
                  status: "resolved",
                  recordId,
                  resolvedAt: new Date(),
                },
              },
            }),
          },
        });
        return leadResponse(saved);
      });
    } catch (error) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        const row = await tx.personalDiscoveryRun.findFirst({ where: { id, userId } });
        if (!row || objectValue(row.details).claim !== claim) return;
        const lead = leadResponse(row);
        await tx.personalDiscoveryRun.update({
          where: { id },
          data: {
            details: jsonValue({
              ...objectValue(row.details),
              claim: null,
              claimExpiresAt: null,
              lead: {
                ...lead,
                resolution: {
                  ...lead.resolution,
                  status: "blocked",
                  reason:
                    "Official source resolution did not produce fresh authorized requisition evidence; review source health and registry before retrying",
                },
              },
            }),
          },
        });
      });
      throw error;
    }
  }

  private async saveBatch(userId: string, input: BatchInput) {
    const batchId = randomUUID();
    const snapshot =
      typeof input.snapshot === "string"
        ? Buffer.from(input.snapshot)
        : Buffer.from(input.snapshot);
    if (snapshot.length > 2_000_000) throw badRequest("Lead snapshot exceeds 2 MB");
    const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
    const directory = path.join(personalRoot(), "storage", userId, "lead-snapshots");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, `${batchId}.snapshot`), snapshot, {
      mode: 0o600,
      flag: "wx",
    });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      let imported = 0;
      let duplicates = input.duplicates ?? 0;
      let excluded = input.excluded ?? 0;
      const diagnostics = [...(input.diagnostics ?? [])];
      const leadIds: string[] = [];
      for (const candidate of input.candidates) {
        let url: string;
        try {
          normalizeLeadUrl(candidate.originalUrl);
          url = normalizeLeadUrl(candidate.candidateDestinationUrl ?? candidate.originalUrl);
        } catch {
          excluded++;
          diagnostics.push(`Rejected unsafe URL in source row ${candidate.sourceRowId}`);
          continue;
        }
        const fingerprint = manifestHash({ url });
        const existing = await tx.personalDiscoveryRun.findFirst({
          where: {
            userId,
            source: { startsWith: "lead:" },
            details: { path: ["lead", "fingerprint"], equals: fingerprint },
          },
        });
        if (existing) {
          duplicates++;
          leadIds.push(existing.id);
          continue;
        }
        const id = randomUUID();
        const lead = personalLeadSchema.parse({
          id,
          batchId,
          source: input.source,
          ...candidate,
          candidateDestinationUrl: url,
          discoveredAt: new Date(),
          postedAt: candidate.postedAt ? new Date(candidate.postedAt) : null,
          snapshotHash,
          fingerprint,
          fullDescriptionAvailable: false,
          employerIdentityVerified: false,
          resolution: {
            status: "unresolved",
            reason: null,
            officialUrl: null,
            sourceIdentity: null,
            recordId: null,
            resolvedAt: null,
          },
        });
        await tx.personalDiscoveryRun.create({
          data: {
            id,
            userId,
            source: `lead:${input.source}`,
            status: "complete",
            details: jsonValue({ kind: "lead", lead, rowHash: manifestHash(candidate) }),
          },
        });
        leadIds.push(id);
        imported++;
      }
      const status =
        excluded > (input.excluded ?? 0) && input.status === "complete" ? "partial" : input.status;
      await tx.personalDiscoveryRun.create({
        data: {
          id: batchId,
          userId,
          source: `lead_batch:${input.source}`,
          status,
          details: jsonValue({
            kind: "lead_batch",
            count: imported,
            leadIds,
            snapshotHash,
            snapshotFilename: `${batchId}.snapshot`,
            duplicates,
            excluded,
            diagnostics: diagnostics.slice(0, 100),
            metadata: input.metadata ?? {},
            nextEligibleAt: input.nextEligibleAt ?? null,
          }),
        },
      });
      return {
        batchId,
        imported,
        duplicates,
        excluded,
        status,
        diagnostics: diagnostics.slice(0, 100),
        nextEligibleAt: input.nextEligibleAt ?? null,
      };
    });
  }
}
