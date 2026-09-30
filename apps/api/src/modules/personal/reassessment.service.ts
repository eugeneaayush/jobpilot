import { pageSlice } from "@jobpilot/contracts/pagination";
import { singleton } from "tsyringe";
import { type Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  eligibilityContext,
  eligibilityFreshness,
  eligibilityRefreshAttemptWhere,
  eligibilityRefreshClaimed,
} from "./eligibility-freshness";
import { type CandidateFacts, evaluatePosting } from "./evaluation";
import { campaignKeywords } from "./fit-evaluation";
import { manifestHash } from "./persistence-policy";
import { PersonalService } from "./personal.service";
import { preparationPreviewHash } from "./preparation-policy";
import {
  adjudicatedRequirements,
  overallEligibility,
  recoveryContext,
  sameRecoveryContext,
} from "./recovery-policy";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { jsonValue, objectValue, stringsValue, textValue } from "./runtime";

@singleton()
export class PersonalReassessmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
  ) {}

  async refreshStale(userId: string, recordIds: string[]) {
    if (!recordIds.length) return { evaluated: 0, skipped: 0 };
    return this.reassess(userId, {
      recordIds: [...new Set(recordIds)].slice(0, 25),
      onlyStale: true,
    });
  }

  async reassess(
    userId: string,
    options: { recordIds?: string[]; onlyStale?: boolean } = {},
  ): Promise<{ evaluated: number; skipped: number }> {
    const [settings, { data: resume, evidence }] = await Promise.all([
      this.personal.settings(userId),
      this.personal.resumeData(userId),
    ]);
    const facts: CandidateFacts = {
      ...(settings.mbaEnrolled !== null && { mbaEnrolled: settings.mbaEnrolled }),
      ...(settings.graduationYear !== null && { mbaGraduationYear: settings.graduationYear }),
      ...(settings.workAuthorization !== null && { workAuthorized: settings.workAuthorization }),
      workAuthorizationCountries: settings.workAuthorizationCountries,
      ...(settings.requiresSponsorship !== null && {
        sponsorshipRequired: settings.requiresSponsorship,
      }),
      ...(settings.citizenship !== null && { citizenship: settings.citizenship }),
      ...(settings.yearsExperience !== null && { yearsExperience: settings.yearsExperience }),
      ...(settings.availableFrom !== null && { availabilityStart: settings.availableFrom }),
      ...(settings.availableUntil !== null && { availabilityEnd: settings.availableUntil }),
      ...(settings.availabilityNotes !== null && { availabilityNotes: settings.availabilityNotes }),
    };
    const keywords = campaignKeywords(resume, settings);
    const settingsHash = manifestHash(settings);
    const sources = { settings, evidence };
    const before = new Date();
    const where = {
      userId,
      createdAt: { lte: before },
      ...(options.recordIds && { id: { in: options.recordIds } }),
    };
    const census = await this.prisma.personalRecord.count({
      where,
    });
    const result = { evaluated: 0, skipped: 0 };
    let afterId: string | undefined;
    while (result.evaluated + result.skipped < census) {
      const remaining = census - result.evaluated - result.skipped;
      const rows = await this.prisma.personalRecord.findMany({
        where: { ...where, ...(afterId && { id: { ...where.id, gt: afterId } }) },
        orderBy: { id: "asc" },
        ...pageSlice({ page: 1, limit: Math.min(100, remaining) }),
      });
      if (!rows.length) break;
      for (const row of rows) {
        afterId = row.id;
        if (["applying", "submitted", "submission_uncertain"].includes(row.state)) {
          result.skipped++;
          continue;
        }
        const old = objectValue(row.details);
        if (options.onlyStale && eligibilityFreshness(row, sources).status === "current") {
          result.skipped++;
          continue;
        }
        const source = objectValue(old.posting);
        const posting = {
          title: row.title,
          employer: row.company,
          descriptionText: textValue(source.descriptionText),
          location: typeof source.location === "string" ? source.location : null,
          deadline: typeof source.deadline === "string" ? source.deadline : null,
        };
        const evaluatedAt = new Date();
        const evaluation = evaluatePosting(
          posting,
          facts,
          {
            now: evaluatedAt,
            restrictedEmployers: settings.exclusions,
            preferredLocations: settings.locations,
            keywords,
            ...(settings.minimumCompensation !== null &&
              settings.compensationCurrency &&
              settings.compensationPeriod && {
                minimumCompensation: {
                  amount: settings.minimumCompensation,
                  currency: settings.compensationCurrency,
                  period: settings.compensationPeriod,
                },
              }),
          },
          resume,
        );
        const constraints = settings.recruitingAvailability
          ? assessRecruitingConstraints(posting, settings)
          : null;
        if (constraints) evaluation.requirements.push(...constraints.requirements);
        evaluation.eligibility = overallEligibility(evaluation.requirements);
        evaluation.blockers = [
          ...new Set([
            ...evaluation.blockers,
            ...evaluation.requirements
              .filter((item) => item.status === "violated")
              .map((item) => item.requirement),
          ]),
        ];
        const archivedAt = new Date().toISOString();
        const preservePreview = Boolean(
          options.onlyStale &&
            old.settingsHash === settingsHash &&
            old.resumeEvidenceId === evidence.id &&
            manifestHash(old.evaluation ?? null) === manifestHash(evaluation) &&
            objectValue(old.preview).preparationContextHash ===
              preparationPreviewHash(row, settings, evidence, resume),
        );
        const oldRequirements = objectValue(old.evaluation).requirements;
        const oldNames = new Set(
          Array.isArray(oldRequirements)
            ? oldRequirements.map((item) => objectValue(item).requirement)
            : [],
        );
        const archive = {
          archivedAt,
          state: row.state,
          settingsHash: old.settingsHash,
          resumeEvidenceId: old.resumeEvidenceId,
          evaluation: old.evaluation,
          recruitingConstraints: old.recruitingConstraints,
          eligibility: old.eligibility,
          eligibilityAdjudication: old.eligibilityAdjudication,
          preview: old.preview,
          document: old.document,
          manifestPath: old.manifestPath,
          previewAttachments: old.previewAttachments,
          recoveryTicket: old.recoveryTicket,
          fitScore: old.fitScore,
          fitReasons: old.fitReasons,
          missingAnswers: old.missingAnswers,
        };
        const details = {
          ...old,
          reassessmentHistory: [
            ...(Array.isArray(old.reassessmentHistory) ? old.reassessmentHistory : []),
            archive,
          ],
          evaluation,
          recruitingConstraints: constraints,
          settingsHash,
          resumeEvidenceId: evidence.id,
          fitScore: evaluation.fitScore,
          fitReasons: evaluation.fitReasons,
          fitEvaluation: evaluation.fitEvaluation,
        } as Record<string, unknown>;
        const context = recoveryContext(
          { ...row, details: jsonValue(details) as Prisma.JsonValue },
          settings,
          evidence,
        );
        for (const key of ["eligibilityAdjudication", "recoveryTicket"])
          if (!sameRecoveryContext(objectValue(details[key]).context ?? {}, context))
            delete details[key];
        const reviewed = adjudicatedRequirements(details, context);
        const decision = overallEligibility(reviewed);
        details.eligibility = {
          decision,
          reasons: reviewed.map((item) => `${item.status}: ${item.requirement} — ${item.evidence}`),
        };
        details.missingAnswers = [
          ...new Set([
            ...stringsValue(old.missingAnswers).filter((name) => !oldNames.has(name)),
            ...reviewed.filter((item) => item.status === "unknown").map((item) => item.requirement),
          ]),
        ];
        if (!preservePreview)
          for (const key of ["preview", "document", "manifestPath", "previewAttachments"])
            delete details[key];
        details.eligibilityContext = eligibilityContext(
          { ...row, details: jsonValue(details) as Prisma.JsonValue },
          sources,
          evaluatedAt.getTime(),
        );
        let nextState = row.state;
        if (
          !["blocked", "failed"].includes(nextState) &&
          !(preservePreview && nextState === "prepared")
        )
          nextState = decision === "eligible" ? "eligible" : "discovered";
        const saved = await this.prisma.$transaction(
          async (tx) => {
            // Match attempt reservation's user lock before locking the record, so a lease cannot race reassessment.
            const owner = await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
            if (!owner.length) return false;
            await tx.$queryRaw`SELECT id FROM personal_records WHERE id = ${row.id} AND user_id = ${userId} FOR UPDATE`;
            const current = await tx.personalRecord.findFirst({ where: { id: row.id, userId } });
            if (
              !current ||
              current.updatedAt.getTime() !== row.updatedAt.getTime() ||
              ["applying", "submitted", "submission_uncertain"].includes(current.state)
            )
              return false;
            if (eligibilityRefreshClaimed(current)) return false;
            const [currentSettings, currentEvidence] = await Promise.all([
              this.personal.settings(userId),
              tx.personalResumeEvidence.findFirst({
                where: { userId },
                orderBy: { createdAt: "desc" },
              }),
            ]);
            if (
              !currentEvidence ||
              manifestHash(
                eligibilityContext(current, {
                  settings: currentSettings,
                  evidence: currentEvidence,
                }),
              ) !== manifestHash(eligibilityContext(row, sources, evaluatedAt.getTime()))
            )
              return false;
            const active = await tx.personalAttempt.findFirst({
              where: {
                ...eligibilityRefreshAttemptWhere(userId),
                recordId: row.id,
              },
              select: { id: true },
            });
            if (active) return false;
            const changed = await tx.personalRecord.updateMany({
              where: {
                id: row.id,
                userId,
                updatedAt: row.updatedAt,
                state: { notIn: ["applying", "submitted", "submission_uncertain"] },
              },
              data: {
                track: evaluation.track,
                state: nextState,
                details: jsonValue(details),
              },
            });
            return changed.count === 1;
          },
          { timeout: 15000 },
        );
        if (saved) result.evaluated++;
        else result.skipped++;
      }
    }
    return result;
  }
}
