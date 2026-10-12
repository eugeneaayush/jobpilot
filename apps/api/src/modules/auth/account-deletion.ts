import { conflict } from "@/common/errors";
import type { ResumeArtifactRefs } from "@/common/storage/storage";
import type { PrismaClient } from "@/generated/prisma/client";

/** Delete the user row (every relation cascades) and return the resume files left on disk. */
export async function deleteAccountRecords(
  db: PrismaClient,
  userId: string,
): Promise<ResumeArtifactRefs[]> {
  // The attempt ledger uses RESTRICT keys and a delete-guard trigger, so its cascade would abort.
  if ((await db.personalAttempt.count({ where: { userId } })) > 0) {
    throw conflict("Accounts with a personal application ledger cannot be deleted here");
  }

  const resumes = await db.resume.findMany({
    where: { userId },
    select: { id: true, sourceFilename: true, variants: { select: { id: true } } },
  });
  await db.user.delete({ where: { id: userId } });

  return resumes.map((resume) => ({
    resumeId: resume.id,
    sourceFilename: resume.sourceFilename,
    variantIds: resume.variants.map((variant) => variant.id),
  }));
}
