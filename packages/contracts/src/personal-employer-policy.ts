import { z } from "zod";
import { personalEmployerAliasUpsertSchema } from "./personal-registry";

const domain = personalEmployerAliasUpsertSchema.shape.officialDomain;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    domain.safeParse(url.hostname).success
  );
}, "A public HTTPS source URL is required");
const canonicalEmployer = z.string().refine((value) => {
  if (!value.startsWith("domain:")) return false;
  const parsed = domain.safeParse(value.slice(7));
  return parsed.success && value === `domain:${parsed.data}`;
}, "An exact canonical public employer domain is required");

export const personalEmployerAliasEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    verification: z.literal("owner_attested"),
    ownerId: z.uuid(),
    attestedAt: z.iso.datetime(),
    officialDomain: domain,
    recordId: z.uuid(),
    postingContentHash: hash,
    sourceUrl,
    quote: z.string().trim().min(20).max(2000),
    history: z.array(z.json()).max(100),
  })
  .strict();

export const personalEmployerPoliciesSchema = z
  .array(
    z
      .object({
        canonicalEmployer,
        maxActiveApplications: z.number().int().min(0).max(3),
        evidence: z
          .object({
            verification: z.literal("owner_attested"),
            sourceUrl,
            sha256: hash,
            quote: z.string().trim().min(20).max(2000),
            ownerConfirmsPolicy: z.literal(true),
          })
          .strict(),
      })
      .strict(),
  )
  .max(1000)
  .refine(
    (items) => new Set(items.map((item) => item.canonicalEmployer)).size === items.length,
    "Employer policies must identify distinct canonical employers",
  );
