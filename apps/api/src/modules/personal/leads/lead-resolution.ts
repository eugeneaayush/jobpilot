import { personalEmployerAliasEvidenceSchema } from "@jobpilot/contracts/personal-employer-policy";
import { personalRegisteredSourceSchema } from "@jobpilot/contracts/personal-registry";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { conflict } from "@/common/errors";
import type { Prisma } from "@/generated/prisma/client";
import { verifyDiscoveryAuthorization } from "../discovery-authorization";
import { objectValue } from "../runtime";
import { officialLeadDestination } from "./lead-policy";

export async function authorizeLeadDestination(
  tx: Pick<Prisma.TransactionClient, "campaign" | "personalSource" | "personalEmployerAlias">,
  userId: string,
  input: { campaignId: string; runId: string },
  destination: ReturnType<typeof officialLeadDestination>,
) {
  await verifyDiscoveryAuthorization(tx, userId, input, destination.sourceIdentity);
  const registry = await tx.personalSource.findUnique({
    where: { userId_identity: { userId, identity: destination.sourceIdentity } },
  });
  const parsed = personalRegisteredSourceSchema.safeParse(registry?.configuration);
  if (!parsed.success || personalSourceIdentity(parsed.data) !== destination.sourceIdentity)
    throw conflict("The official ATS source must be registered before resolving this lead");
  const alias = await tx.personalEmployerAlias.findUnique({
    where: { userId_sourceEmployer: { userId, sourceEmployer: destination.sourceIdentity } },
  });
  const evidence = personalEmployerAliasEvidenceSchema.safeParse(alias?.evidence);
  if (
    !alias ||
    !evidence.success ||
    evidence.data.ownerId !== userId ||
    alias.canonicalEmployer !== `domain:${evidence.data.officialDomain}`
  )
    throw conflict(
      "Verify the official source's employer identity in the registry before resolving this lead",
    );
  return { configuration: parsed.data, canonicalEmployer: alias.canonicalEmployer };
}

export function resolvedLeadRecord(
  record: { id: string; identity: string; details: unknown } | null,
  destination: ReturnType<typeof officialLeadDestination>,
  discoveryRunId: string,
): string {
  if (!record || record.identity !== destination.identity)
    throw conflict("The official source did not return this requisition");
  const details = objectValue(record.details);
  const posting = objectValue(details.posting);
  if (
    details.sourceRunId !== discoveryRunId ||
    typeof posting.descriptionText !== "string" ||
    !posting.descriptionText.trim() ||
    typeof posting.contentHash !== "string"
  )
    throw conflict(
      "The requisition has no fresh full-description evidence from this discovery run",
    );
  const observed = officialLeadDestination(String(posting.url));
  if (observed.identity !== destination.identity || posting.nativeId !== destination.nativeId)
    throw conflict("Official posting identity differs from the requested requisition");
  return record.id;
}
