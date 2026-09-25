import { z } from "zod";
import { paginatedSchema } from "./pagination";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const personalRegisteredSourceSchema = z
  .object({
    source: z.enum(["greenhouse", "lever", "ashby", "cbs"]),
    boardToken: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    region: z.enum(["global", "eu"]).optional(),
    employer: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine(
    (value) => value.source === "lever" || value.region === undefined,
    "Region applies only to Lever",
  );
export const personalSourceUpsertSchema = z
  .object({
    configuration: personalRegisteredSourceSchema,
    expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const personalRegistrySourceSchema = z.object({
  id: z.uuid(),
  identity: z.string(),
  configuration: personalRegisteredSourceSchema.nullable(),
  configurationState: z.enum(["valid", "invalid"]),
  attemptedAt: z.date().nullable(),
  lastSuccessfulAt: z.date().nullable(),
  nextEligibleAt: z.date().nullable(),
  updatedAt: z.date(),
  status: z.enum(["complete", "partial", "blocked", "failed"]).nullable(),
  coverage: z.json(),
  adapter: z.object({
    discovery: z.enum(["public_api", "import_only", "unsupported"]),
    submission: z.enum(["guarded_greenhouse", "restricted_lever", "unsupported"]),
    readiness: z.literal("not_evaluated"),
    submissionEnabledByRegistration: z.literal(false),
  }),
});
export const personalRegistryResponseSchema = z.object({
  sources: z.array(personalRegistrySourceSchema),
  pagination: paginatedSchema(personalRegistrySourceSchema).shape.pagination,
});

const officialDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .refine(
    (domain) => !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(domain),
    "A public official domain is required",
  );
export const personalEmployerAliasUpsertSchema = z
  .object({
    source: personalRegisteredSourceSchema.refine(
      (value) => value.source !== "cbs",
      "CBS exports need per-employer identities; board-wide aliases are unsupported",
    ),
    officialDomain,
    recordId: z.uuid(),
    postingContentHash: sha,
    quote: z.string().trim().min(20).max(2000),
    ownerConfirmsOfficialIdentity: z.literal(true),
    expectedEvidenceHash: sha.nullable(),
  })
  .strict();
export const personalRegistryAliasSchema = z.object({
  id: z.uuid(),
  sourceIdentity: z.string(),
  canonicalEmployer: z.string(),
  verification: z.enum(["owner_attested", "legacy_unverified"]),
  evidenceHash: sha,
  evidence: z.json(),
  createdAt: z.date(),
  replacementRule: z.literal("blocked_after_any_attempt_or_reservation"),
});
export const personalRegistryAliasesSchema = z.object({
  aliases: z.array(personalRegistryAliasSchema),
  pagination: paginatedSchema(personalRegistryAliasSchema).shape.pagination,
});

export const personalUserPolicySchema = z.object({
  dailyCap: z.number().int().min(0).max(50),
  employerActiveCap: z.number().int().min(0).max(3),
  monthlyBudgetCents: z.number().int().min(0).max(20000),
  searchBudgetCents: z.number().int().min(0).max(5000),
  timezone: z.string(),
  version: z.string(),
  updatedAt: z.date().nullable(),
  ceilings: z.object({
    dailyCap: z.literal(50),
    employerActiveCap: z.literal(3),
    monthlyBudgetCents: z.literal(20000),
    searchBudgetCents: z.literal(5000),
    timezone: z.literal("America/New_York"),
  }),
  adjustment: z.literal("downward_only"),
});
export const personalUserPolicyUpdateSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
    dailyCap: z.number().int().min(0).max(50).optional(),
    employerActiveCap: z.number().int().min(0).max(3).optional(),
    monthlyBudgetCents: z.number().int().min(0).max(20000).optional(),
    searchBudgetCents: z.number().int().min(0).max(5000).optional(),
    timezone: z.literal("America/New_York").optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"),
    "A policy adjustment is required",
  );
