import { conflict, notFound } from "@/common/errors";
import type { ResumeArtifactRefs } from "@/common/storage/storage";
import type { PrismaClient } from "@/generated/prisma/client";

/** Delete the user row (every relation cascades) and return the resume files left on disk. */
export function deleteAccountRecords(
  db: PrismaClient,
  userId: string,
): Promise<ResumeArtifactRefs[]> {
  return db.$transaction(
    async (tx) => {
      // The row locks make a concurrent resume insert or source update either commit before the
      // snapshot below or fail after the delete, where its writer removes its own new file.
      const owners = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!owners.length) throw notFound("User not found");

      // The attempt ledger uses RESTRICT keys and a delete-guard trigger, so its cascade would abort.
      if ((await tx.personalAttempt.count({ where: { userId } })) > 0) {
        throw conflict("Accounts with a personal application ledger cannot be deleted here");
      }

      await tx.$queryRaw`SELECT id FROM resumes WHERE user_id = ${userId} FOR UPDATE`;
      const resumes = await tx.resume.findMany({
        where: { userId },
        select: { id: true, sourceFilename: true, variants: { select: { id: true } } },
      });
      await tx.user.delete({ where: { id: userId } });

      return resumes.map((resume) => ({
        resumeId: resume.id,
        sourceFilename: resume.sourceFilename,
        variantIds: resume.variants.map((variant) => variant.id),
      }));
    },
    // A large account's cascade can outlast Prisma's 5s interactive-transaction default.
    { timeout: 30_000 },
  );
}
