import { z } from "zod/v4";
import { personalTailoringResponseSchema } from "./personal-tailoring";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const structuralOperation = z
  .object({
    kind: z.enum(["cut", "reorder"]),
    path: z.string().min(1).max(200),
    before: z.union([z.array(z.string()), z.array(z.number().int().nonnegative())]),
    after: z.union([z.array(z.string()), z.array(z.number().int().nonnegative())]),
  })
  .strict();

export const personalDocumentEditsSchema = z
  .object({
    version: z.literal(1),
    baseDataHash: hash,
    sourceSha256: hash,
    sourceDigest: hash,
    proposalHash: hash,
    requiresIndependentReview: z.literal(true),
    operations: z.array(structuralOperation).max(1000),
  })
  .strict();

export const personalYamlExportSchema = z
  .object({
    recordVersion: hash,
    sourceSha256: hash,
    configSha256: hash,
    rendererVersion: z.string(),
    bundleYaml: z.string().max(1_000_000),
  })
  .strict();

export const personalYamlImportSchema = z
  .object({
    recordVersion: hash,
    bundleYaml: z.string().min(1).max(1_000_000),
  })
  .strict();

export const personalYamlImportResponseSchema = z
  .object({
    recordVersion: hash,
    sourceSha256: hash,
    requiresIndependentReview: z.literal(true),
    structuralOperations: z.number().int().nonnegative(),
    tailoring: personalTailoringResponseSchema,
  })
  .strict();

export type PersonalDocumentEdits = z.infer<typeof personalDocumentEditsSchema>;
