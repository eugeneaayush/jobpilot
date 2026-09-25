import { personalEmployerAliasEvidenceSchema } from "@jobpilot/contracts/personal-employer-policy";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { conflict } from "@/common/errors";
import type { Prisma } from "@/generated/prisma/client";
import { employerPolicyLimit } from "./employer-policy.service";
import { objectValue, personalConfiguration } from "./runtime";

export function userPolicy(tx: Prisma.TransactionClient, userId: string) {
  return tx.personalPolicy.upsert({ where: { userId }, create: { userId }, update: {} });
}

export async function employerIdentity(
  tx: Prisma.TransactionClient,
  userId: string,
  record: { company: string; details: unknown },
) {
  const posting = objectValue(objectValue(record.details).posting);
  const source = posting.source;
  const knownSource =
    source === "greenhouse" || source === "lever" || source === "ashby" || source === "cbs";
  const sourceEmployer = knownSource
    ? personalSourceIdentity({
        source,
        boardToken: String(posting.boardToken),
        region: posting.sourceRegion === "eu" ? "eu" : "global",
      })
    : `unknown:${String(posting.boardToken)}`;
  const alias =
    !knownSource || source === "cbs"
      ? null
      : await tx.personalEmployerAlias.findUnique({
          where: { userId_sourceEmployer: { userId, sourceEmployer } },
        });
  if (alias) {
    const evidence = personalEmployerAliasEvidenceSchema.safeParse(alias.evidence);
    if (
      !evidence.success ||
      evidence.data.ownerId !== userId ||
      alias.canonicalEmployer !== `domain:${evidence.data.officialDomain}`
    )
      throw conflict(
        "Employer alias evidence is unverified; review the source-backed owner attestation before preparing another application.",
      );
    return alias.canonicalEmployer;
  }
  return `name:${record.company.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export async function enforceEmployerCap(
  tx: Prisma.TransactionClient,
  userId: string,
  employer: string,
  cap: number,
  exceptAttemptId?: string,
  configuration: typeof personalConfiguration = personalConfiguration,
) {
  const effectiveCap = await employerPolicyLimit(userId, employer, cap, configuration);
  const active = await tx.personalAttempt.findMany({
    where: {
      userId,
      mode: "submit",
      state: { in: ["preparing", "prepared", "submitting", "submitted", "submission_uncertain"] },
      ...(exceptAttemptId && { id: { not: exceptAttemptId } }),
    },
    include: { record: true },
  });
  let count = 0;
  for (const attempt of active) {
    const canonical = await employerIdentity(tx, userId, attempt.record);
    if (canonical === employer) count++;
  }
  if (count >= effectiveCap)
    throw conflict("Employer active-application limit reached; this role remains queued.");
}
