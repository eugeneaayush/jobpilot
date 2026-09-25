import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { pageSlice, paginate, paginationQuerySchema } from "@jobpilot/contracts/pagination";
import {
  personalEmployerAliasUpsertSchema,
  personalRegisteredSourceSchema,
  personalRegistryAliasSchema,
  personalRegistrySourceSchema,
  personalSourceUpsertSchema,
  personalUserPolicySchema,
  personalUserPolicyUpdateSchema,
} from "@jobpilot/contracts/personal-registry";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { singleton } from "tsyringe";
import type { z } from "zod";
import { badRequest, conflict, notFound } from "@/common/errors";
import {
  type PersonalEmployerAlias,
  type PersonalPolicy,
  type PersonalSource,
  type Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { manifestHash } from "./persistence-policy";

const ceilings = {
  dailyCap: 50,
  employerActiveCap: 3,
  monthlyBudgetCents: 20000,
  searchBudgetCents: 5000,
  timezone: "America/New_York",
} as const;
const defaultPolicy = { ...ceilings, version: "graduate-experienced-v1", updatedAt: null };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const evidenceHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function versionMatches(actual: Date | null, expected: Date | null) {
  if (actual?.getTime() !== expected?.getTime())
    throw conflict("Registry changed; reload before updating");
}
function sourceResponse(row: PersonalSource) {
  const parsed = personalRegisteredSourceSchema.safeParse(row.configuration);
  const configuration =
    parsed.success && personalSourceIdentity(parsed.data) === row.identity ? parsed.data : null;
  let discovery: "public_api" | "import_only" | "unsupported" = "unsupported";
  if (configuration) discovery = configuration.source === "cbs" ? "import_only" : "public_api";
  let submission: "guarded_greenhouse" | "restricted_lever" | "unsupported" = "unsupported";
  if (configuration?.source === "greenhouse") submission = "guarded_greenhouse";
  if (configuration?.source === "lever") submission = "restricted_lever";
  return personalRegistrySourceSchema.parse({
    id: row.id,
    identity: row.identity,
    configuration,
    configurationState: configuration ? ("valid" as const) : ("invalid" as const),
    attemptedAt: row.attemptedAt,
    lastSuccessfulAt: row.completedAt,
    nextEligibleAt: row.nextEligibleAt,
    updatedAt: row.updatedAt,
    status: row.status,
    coverage: row.coverage,
    adapter: {
      discovery,
      submission,
      readiness: "not_evaluated" as const,
      submissionEnabledByRegistration: false as const,
    },
  });
}
function aliasResponse(row: PersonalEmployerAlias) {
  return personalRegistryAliasSchema.parse({
    id: row.id,
    sourceIdentity: row.sourceEmployer,
    canonicalEmployer: row.canonicalEmployer,
    verification:
      object(row.evidence).verification === "owner_attested"
        ? ("owner_attested" as const)
        : ("legacy_unverified" as const),
    evidenceHash: evidenceHash({
      canonicalEmployer: row.canonicalEmployer,
      evidence: row.evidence,
    }),
    evidence: row.evidence,
    createdAt: row.createdAt,
    replacementRule: "blocked_after_any_attempt_or_reservation" as const,
  });
}
function policyResponse(row: PersonalPolicy | null) {
  const policy = row ?? defaultPolicy;
  return personalUserPolicySchema.parse({
    dailyCap: policy.dailyCap,
    employerActiveCap: policy.employerActiveCap,
    monthlyBudgetCents: policy.monthlyBudgetCents,
    searchBudgetCents: policy.searchBudgetCents,
    timezone: policy.timezone,
    version: policy.version,
    updatedAt: policy.updatedAt,
    ceilings,
    adjustment: "downward_only" as const,
  });
}
async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!rows.length) throw notFound("Account not found");
}

@singleton()
export class PersonalSourceRegistryService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, query: z.input<typeof paginationQuerySchema> = {}) {
    const parsed = paginationQuerySchema.parse(query);
    const [rows, total] = await Promise.all([
      this.prisma.personalSource.findMany({
        where: { userId },
        orderBy: { identity: "asc" },
        ...pageSlice(parsed),
      }),
      this.prisma.personalSource.count({ where: { userId } }),
    ]);
    const { items: sources, pagination } = paginate(rows.map(sourceResponse), parsed, total);
    return { sources, pagination };
  }

  async upsert(userId: string, input: z.input<typeof personalSourceUpsertSchema>) {
    const parsed = personalSourceUpsertSchema.parse(input);
    const configuration = {
      ...parsed.configuration,
      ...(parsed.configuration.source === "lever" && {
        region: parsed.configuration.region ?? "global",
      }),
    };
    const identity = personalSourceIdentity(configuration);
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.personalSource.findUnique({
        where: { userId_identity: { userId, identity } },
      });
      versionMatches(
        current?.updatedAt ?? null,
        parsed.expectedUpdatedAt ? new Date(parsed.expectedUpdatedAt) : null,
      );
      if (!current) {
        return sourceResponse(
          await tx.personalSource.create({
            data: { userId, identity, configuration: json(configuration) },
          }),
        );
      }
      const changed = await tx.personalSource.updateMany({
        where: { id: current.id, userId, updatedAt: current.updatedAt },
        data: {
          configuration: json(configuration),
          updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
        },
      });
      if (changed.count !== 1)
        throw conflict("Source changed concurrently; reload before updating");
      return sourceResponse(
        await tx.personalSource.findUniqueOrThrow({ where: { id: current.id } }),
      );
    });
  }

  async listAliases(userId: string, query: z.input<typeof paginationQuerySchema> = {}) {
    const parsed = paginationQuerySchema.parse(query);
    const [rows, total] = await Promise.all([
      this.prisma.personalEmployerAlias.findMany({
        where: { userId },
        orderBy: { sourceEmployer: "asc" },
        ...pageSlice(parsed),
      }),
      this.prisma.personalEmployerAlias.count({ where: { userId } }),
    ]);
    const { items: aliases, pagination } = paginate(rows.map(aliasResponse), parsed, total);
    return { aliases, pagination };
  }

  async registerAlias(userId: string, input: z.input<typeof personalEmployerAliasUpsertSchema>) {
    const parsed = personalEmployerAliasUpsertSchema.parse(input);
    const sourceIdentity = personalSourceIdentity(parsed.source);
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const source = await tx.personalSource.findUnique({
        where: { userId_identity: { userId, identity: sourceIdentity } },
      });
      if (!source || !sourceResponse(source).configuration)
        throw notFound("Register a valid owned source first");
      const old = await tx.personalEmployerAlias.findUnique({
        where: { userId_sourceEmployer: { userId, sourceEmployer: sourceIdentity } },
      });
      const oldHash = old ? aliasResponse(old).evidenceHash : null;
      if (oldHash !== parsed.expectedEvidenceHash)
        throw conflict("Employer evidence changed; reload before updating");
      const used = await tx.personalAttempt.count({
        where: { userId, record: { identity: { startsWith: `${sourceIdentity}:` } } },
      });
      const reserved = await tx.personalReservation.count({
        where: { userId, identity: { startsWith: `${sourceIdentity}:` } },
      });
      if (used || reserved)
        throw conflict(
          "Employer identity is immutable after an attempt or reservation exists for this source",
        );
      const record = await tx.personalRecord.findFirst({ where: { id: parsed.recordId, userId } });
      if (!record?.identity.startsWith(`${sourceIdentity}:`))
        throw notFound("Owned evidence record does not match this source");
      const posting = object(object(record.details).posting);
      const postingSource = personalRegisteredSourceSchema.safeParse({
        source: posting.source,
        boardToken: posting.boardToken,
        ...(posting.source === "lever" && { region: posting.sourceRegion ?? "global" }),
      });
      if (!postingSource.success || personalSourceIdentity(postingSource.data) !== sourceIdentity)
        throw badRequest("Saved posting source identity does not match the registered source");
      const postingHash =
        typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting);
      if (postingHash !== parsed.postingContentHash)
        throw conflict("Posting evidence changed; review the current source");
      if (
        typeof posting.descriptionText !== "string" ||
        !posting.descriptionText.includes(parsed.quote)
      )
        throw badRequest(
          "Evidence quote must occur verbatim in the saved full posting description",
        );
      let sourceUrl: URL;
      try {
        sourceUrl = new URL(String(posting.sourceUrl));
      } catch {
        throw badRequest("Saved evidence has no source URL");
      }
      if (
        sourceUrl.protocol !== "https:" ||
        sourceUrl.username ||
        sourceUrl.password ||
        sourceUrl.port ||
        isIP(sourceUrl.hostname.replace(/^\[|\]$/g, "")) ||
        !sourceUrl.hostname.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(sourceUrl.hostname)
      )
        throw badRequest("Saved source provenance must be a public HTTPS URL");
      const canonicalEmployer = `domain:${parsed.officialDomain}`;
      const previous = old ? object(old.evidence) : {};
      const history = Array.isArray(previous.history) ? [...previous.history] : [];
      if (old) {
        const { history: _history, ...prior } = previous;
        history.push({ canonicalEmployer: old.canonicalEmployer, evidence: prior });
      }
      if (history.length >= 100) throw conflict("Employer evidence revision limit reached");
      const evidence = json({
        schemaVersion: 1,
        verification: "owner_attested",
        ownerId: userId,
        attestedAt: new Date().toISOString(),
        officialDomain: parsed.officialDomain,
        recordId: record.id,
        postingContentHash: postingHash,
        sourceUrl: sourceUrl.href,
        quote: parsed.quote,
        history,
      });
      if (!old)
        return aliasResponse(
          await tx.personalEmployerAlias.create({
            data: { userId, sourceEmployer: sourceIdentity, canonicalEmployer, evidence },
          }),
        );
      const changed = await tx.personalEmployerAlias.updateMany({
        where: {
          id: old.id,
          userId,
          evidence: { equals: old.evidence as Prisma.InputJsonValue },
          canonicalEmployer: old.canonicalEmployer,
        },
        data: { canonicalEmployer, evidence },
      });
      if (changed.count !== 1)
        throw conflict("Employer alias changed concurrently; reload before updating");
      return aliasResponse(
        await tx.personalEmployerAlias.findUniqueOrThrow({ where: { id: old.id } }),
      );
    });
  }

  async policy(userId: string) {
    return policyResponse(await this.prisma.personalPolicy.findUnique({ where: { userId } }));
  }

  async configurePolicy(userId: string, input: z.input<typeof personalUserPolicyUpdateSchema>) {
    const parsed = personalUserPolicyUpdateSchema.parse(input);
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const row = await tx.personalPolicy.findUnique({ where: { userId } });
      versionMatches(
        row?.updatedAt ?? null,
        parsed.expectedUpdatedAt ? new Date(parsed.expectedUpdatedAt) : null,
      );
      const old = row ?? defaultPolicy;
      if (old.timezone !== "America/New_York")
        throw conflict("Legacy policy timezone requires a separate reviewed migration");
      const { expectedUpdatedAt: _expected, ...changes } = parsed;
      const next = { ...old, ...changes };
      for (const key of [
        "dailyCap",
        "employerActiveCap",
        "monthlyBudgetCents",
        "searchBudgetCents",
      ] as const) {
        if (next[key] > old[key])
          throw badRequest("Policy limits can only be lowered through this endpoint");
      }
      if (next.searchBudgetCents > next.monthlyBudgetCents)
        throw badRequest("Search budget cannot exceed the total monthly budget");
      const data = {
        ...changes,
        timezone: "America/New_York",
        updatedAt: new Date(Math.max(Date.now(), (row?.updatedAt.getTime() ?? 0) + 1)),
      };
      if (!row)
        return policyResponse(await tx.personalPolicy.create({ data: { userId, ...data } }));
      const changed = await tx.personalPolicy.updateMany({
        where: { userId, updatedAt: row.updatedAt },
        data,
      });
      if (changed.count !== 1)
        throw conflict("Policy changed concurrently; reload before updating");
      return policyResponse(await tx.personalPolicy.findUniqueOrThrow({ where: { userId } }));
    });
  }
}
