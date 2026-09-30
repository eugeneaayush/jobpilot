import path from "node:path";
import { personalDiscoverSchema } from "@jobpilot/contracts/personal";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { singleton } from "tsyringe";
import { z } from "zod";
import { conflict, ErrorCodes, HttpError } from "@/common/errors";
import { type PersonalRecord, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { type DiscoveryResult, discoverGreenhouse } from "./discovery";
import { verifyDiscoveryAuthorization } from "./discovery-authorization";
import { discoverAshby } from "./discovery-connectors/ashby";
import { normalizeCbsImport } from "./discovery-connectors/cbs";
import { discoverLever } from "./discovery-connectors/lever";
import type { ConnectorResult } from "./discovery-connectors/types";
import {
  eligibilityContext,
  eligibilityFreshness,
  eligibilityRefreshAttemptWhere,
  eligibilityRefreshClaimed,
} from "./eligibility-freshness";
import { type CandidateFacts, evaluatePosting } from "./evaluation";
import { campaignKeywords } from "./fit-evaluation";
import { requireFullDiscoveryDescriptions } from "./leads/lead-policy";
import { manifestHash } from "./persistence-policy";
import { PersonalService } from "./personal.service";
import {
  adjudicatedRequirements,
  overallEligibility,
  recoveryContext,
  sameRecoveryContext,
} from "./recovery-policy";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { jsonValue, objectValue, personalRoot, readSettings, savePrivate } from "./runtime";

@singleton()
export class PersonalDiscoveryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
  ) {}

  async discover(userId: string, input: z.input<typeof personalDiscoverSchema>) {
    const provider = input.source ?? "greenhouse";
    const sourceIdentity = personalSourceIdentity({ ...input, source: provider });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      await verifyDiscoveryAuthorization(tx, userId, input, sourceIdentity);
      const registry = await tx.personalSource.findUnique({
        where: { userId_identity: { userId, identity: sourceIdentity } },
      });
      if (registry?.nextEligibleAt && registry.nextEligibleAt > new Date())
        throw new HttpError(ErrorCodes.RATE_LIMITED, "Source cooldown is active", 429, undefined, {
          "retry-after": String(Math.ceil((registry.nextEligibleAt.getTime() - Date.now()) / 1000)),
          "x-jobpilot-retry-scope": "source",
        });
      await tx.personalSource.upsert({
        where: { userId_identity: { userId, identity: sourceIdentity } },
        create: {
          userId,
          identity: sourceIdentity,
          configuration: jsonValue({
            source: provider,
            boardToken: input.boardToken,
            region: input.region,
            employer: input.employer,
          }),
          attemptedAt: new Date(),
          nextEligibleAt: new Date(Date.now() + 60000),
        },
        update: { attemptedAt: new Date(), nextEligibleAt: new Date(Date.now() + 60000) },
      });
    });
    const { data: resume, evidence } = await this.personal.resumeData(userId);
    const settings = await readSettings(userId);
    const authorizedFetch = (async (...args: Parameters<typeof fetch>) => {
      await verifyDiscoveryAuthorization(this.prisma, userId, input, sourceIdentity);
      return fetch(...args);
    }) as typeof fetch;
    let result: DiscoveryResult | ConnectorResult;
    if (provider === "lever")
      result = await discoverLever(input.boardToken, {
        employer: input.employer,
        region: input.region,
        fetch: authorizedFetch,
      });
    else if (provider === "ashby")
      result = await discoverAshby(input.boardToken, {
        employer: input.employer,
        fetch: authorizedFetch,
      });
    else if (provider === "cbs") {
      if (!input.importText || !input.importFormat || !input.sourceUrl)
        throw conflict("CBS import requires text, format and original source URL");
      result = normalizeCbsImport(input.importText, {
        boardToken: input.boardToken,
        format: input.importFormat,
        sourceUrl: input.sourceUrl,
      });
    } else
      result = await discoverGreenhouse(input.boardToken, {
        employer: input.employer,
        fetch: authorizedFetch,
      });
    requireFullDiscoveryDescriptions(result);
    const run = await this.prisma.personalDiscoveryRun.create({
      data: {
        userId,
        source: sourceIdentity,
        status: result.status,
        details: jsonValue({
          count: result.postings.length,
          error: result.health.errors.join("; ") || null,
          sourceUrl: result.sourceUrl,
          contentHash: result.contentHash,
          expectedTotal: result.expectedTotal,
          health: result.health,
        }),
      },
    });
    await savePrivate(
      path.join(personalRoot(), "storage", userId, "sources", `${run.id}.json`),
      result,
    );
    const campaign = await this.prisma.campaign.create({
      data: {
        userId,
        query: `${provider}: ${input.boardToken}`,
        source: "search",
        status: "paused",
        config: jsonValue({
          board: provider,
          personal: {
            enabled: false,
            mode: "offline",
            dailyCap: settings.dailyCap,
            maxApplications: settings.maxApplications,
            timezone: settings.timezone,
            policyVersion: "1",
          },
        }),
      },
    });
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
    const existing = await this.prisma.personalRecord.findMany({
      where: { userId, identity: { startsWith: `${sourceIdentity}:` } },
    });
    const byIdentity = new Map(existing.map((record) => [record.identity, record]));
    let skippedConcurrent = 0;
    for (let offset = 0; offset < result.postings.length; offset += 20) {
      await Promise.all(
        result.postings.slice(offset, offset + 20).map(async (posting) => {
          const identity = `${sourceIdentity}:${posting.nativeId}`;
          const evaluation = evaluatePosting(
            posting,
            facts,
            {
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
          if (settings.recruitingAvailability) {
            evaluation.requirements.push(
              ...assessRecruitingConstraints(posting, settings).requirements,
            );
            evaluation.eligibility = overallEligibility(evaluation.requirements);
          }
          const job = await this.prisma.job.create({
            data: {
              campaignId: campaign.campaignId,
              key: identity,
              title: posting.title,
              company: posting.employer,
              url: posting.url,
              location: posting.location,
              board: provider,
              description: posting.descriptionText,
              matchScore: evaluation.fitScore,
              matchReason: evaluation.fitReasons.join("\n"),
              status: "pending",
            },
          });
          const old = byIdentity.get(identity);
          if (old && ["applying", "submitted", "submission_uncertain"].includes(old.state)) return;
          const oldDetails = objectValue(old?.details);
          const unchanged =
            Boolean(
              old && eligibilityFreshness(old, { settings, evidence }).status === "current",
            ) &&
            objectValue(oldDetails.posting).contentHash === posting.contentHash &&
            oldDetails.settingsHash === settingsHash &&
            oldDetails.resumeEvidenceId === evidence.id &&
            manifestHash(objectValue(oldDetails.evaluation).requirements ?? []) ===
              manifestHash(evaluation.requirements);
          const details = {
            ...(unchanged ? oldDetails : {}),
            ...(oldDetails.screeningAnswers
              ? { screeningAnswers: oldDetails.screeningAnswers }
              : {}),
            ...(oldDetails.screeningAnswerSnapshots
              ? {
                  screeningAnswerSnapshots: oldDetails.screeningAnswerSnapshots,
                }
              : {}),
            applicationApprovals: oldDetails.applicationApprovals ?? [],
            eligibilityAdjudicationHistory: oldDetails.eligibilityAdjudicationHistory ?? [],
            recoveryHistory: oldDetails.recoveryHistory ?? [],
            handoffHistory: [
              ...(Array.isArray(oldDetails.handoffHistory) ? oldDetails.handoffHistory : []),
              ...(!unchanged && oldDetails.handoff
                ? [
                    {
                      ...objectValue(oldDetails.handoff),
                      browserSessionEvidence: oldDetails.browserSessionEvidence ?? null,
                      archivedAt: new Date().toISOString(),
                    },
                  ]
                : []),
            ],
            attachmentRequirementHistory: oldDetails.attachmentRequirementHistory ?? [],
            attachmentHistory: [
              ...(Array.isArray(oldDetails.attachmentHistory) ? oldDetails.attachmentHistory : []),
              ...(!unchanged && Array.isArray(oldDetails.attachments)
                ? oldDetails.attachments
                : []),
            ],
            previewHistory: [
              ...(Array.isArray(oldDetails.previewHistory) ? oldDetails.previewHistory : []),
              ...(!unchanged && oldDetails.preview
                ? [
                    {
                      preview: oldDetails.preview,
                      document: oldDetails.document ?? null,
                      manifestPath: oldDetails.manifestPath ?? null,
                      attachments: oldDetails.previewAttachments ?? null,
                      supersededAt: new Date().toISOString(),
                    },
                  ]
                : []),
            ],
            posting,
            evaluation,
            settingsHash,
            resumeEvidenceId: evidence.id,
            eligibility: {
              decision: evaluation.eligibility,
              reasons: evaluation.requirements.map(
                (requirement) =>
                  `${requirement.status}: ${requirement.requirement} — ${requirement.evidence}`,
              ),
            },
            fitScore: evaluation.fitScore,
            fitReasons: evaluation.fitReasons,
            fitEvaluation: evaluation.fitEvaluation,
            missingAnswers: evaluation.requirements
              .filter((requirement) => requirement.status === "unknown")
              .map((requirement) => requirement.requirement),
            sourceRunId: run.id,
            eligibilityContext: {},
          };
          const context = recoveryContext(
            { identity, details: jsonValue(details) as Prisma.JsonValue },
            settings,
            evidence,
          );
          const preserveAdjudication = sameRecoveryContext(
            objectValue(oldDetails.eligibilityAdjudication).context ?? {},
            context,
          );
          // A parser-version refresh can retain an active review only against identical fresh evidence.
          Object.assign(details, {
            eligibilityAdjudication: preserveAdjudication
              ? oldDetails.eligibilityAdjudication
              : undefined,
          });
          details.eligibilityContext = eligibilityContext(
            {
              identity,
              title: posting.title,
              company: posting.employer,
              url: posting.url,
              requisitionId: posting.nativeId,
              details: jsonValue(details) as Prisma.JsonValue,
            },
            { settings, evidence },
          );
          const reviewed = adjudicatedRequirements(details, context);
          details.eligibility = {
            decision: overallEligibility(reviewed),
            reasons: reviewed.map(
              (requirement) =>
                `${requirement.status}: ${requirement.requirement} — ${requirement.evidence}`,
            ),
          };
          const priorRequirements = objectValue(oldDetails.evaluation).requirements;
          const priorNames = new Set(
            Array.isArray(priorRequirements)
              ? priorRequirements.map((value) => objectValue(value).requirement)
              : [],
          );
          details.missingAnswers = [
            ...new Set([
              ...((unchanged || preserveAdjudication) && Array.isArray(oldDetails.missingAnswers)
                ? oldDetails.missingAnswers.filter(
                    (value): value is string => typeof value === "string" && !priorNames.has(value),
                  )
                : []),
              ...reviewed
                .filter((requirement) => requirement.status === "unknown")
                .map((requirement) => requirement.requirement),
            ]),
          ];
          const fields = {
            campaignId: campaign.campaignId,
            jobId: job.id,
            title: posting.title,
            company: posting.employer,
            url: posting.url,
            requisitionId: posting.nativeId,
            track: evaluation.track,
            details: jsonValue(details),
          };
          const state =
            old && (unchanged || ["blocked", "failed"].includes(old.state))
              ? old.state
              : details.eligibility.decision === "eligible"
                ? "eligible"
                : "discovered";
          const saved = await saveDiscoveredRecord(
            this.prisma,
            old,
            { userId, identity, ...fields, state },
            { ...fields, state },
          );
          if (!saved) skippedConcurrent++;
        }),
      );
    }
    const status =
      skippedConcurrent > 0 && result.status === "complete" ? "partial" : result.status;
    if (skippedConcurrent > 0) {
      await this.prisma.personalDiscoveryRun.update({
        where: { id: run.id },
        data: {
          status,
          details: jsonValue({
            ...objectValue(run.details),
            skippedConcurrent,
            error: `${skippedConcurrent} records changed concurrently and were preserved; refresh again to reconcile`,
          }),
        },
      });
    }
    const nextEligibleAt =
      result.health.nextEligibleAt ?? new Date(Date.now() + 60 * 60000).toISOString();
    await this.prisma.personalSource.update({
      where: { userId_identity: { userId, identity: sourceIdentity } },
      data: {
        status,
        nextEligibleAt: new Date(nextEligibleAt),
        ...(status === "complete" && { completedAt: new Date() }),
        coverage: jsonValue({
          runId: run.id,
          count: result.postings.length,
          expectedTotal: result.expectedTotal,
          ...("coverage" in result ? result.coverage : {}),
          health: result.health,
        }),
      },
    });
    return {
      campaignId: campaign.campaignId,
      runId: run.id,
      count: result.postings.length,
      status,
      nextEligibleAt,
    };
  }
}

export async function saveDiscoveredRecord(
  db: PrismaClient,
  previous: Pick<PersonalRecord, "id" | "updatedAt"> | undefined,
  create: Prisma.PersonalRecordCreateManyInput,
  update: Prisma.PersonalRecordUpdateManyMutationInput,
): Promise<boolean> {
  if (!previous) {
    const created = await db.personalRecord.createMany({ data: [create], skipDuplicates: true });
    return created.count === 1;
  }
  return db.$transaction(async (tx) => {
    // Use the same lock order as attempt reservation and preparation claims.
    const owner = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id = ${create.userId} FOR UPDATE`;
    if (!owner.length) return false;
    await tx.$queryRaw`SELECT id FROM personal_records WHERE id = ${previous.id} AND user_id = ${create.userId} FOR UPDATE`;
    const current = await tx.personalRecord.findFirst({
      where: { id: previous.id, userId: create.userId, identity: create.identity },
    });
    if (
      !current ||
      current.updatedAt.getTime() !== previous.updatedAt.getTime() ||
      eligibilityRefreshClaimed(current)
    )
      return false;
    const active = await tx.personalAttempt.findFirst({
      where: { ...eligibilityRefreshAttemptWhere(create.userId), recordId: current.id },
      select: { id: true },
    });
    if (active) return false;
    const changed = await tx.personalRecord.updateMany({
      where: {
        id: previous.id,
        userId: create.userId,
        identity: create.identity,
        updatedAt: previous.updatedAt,
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: update,
    });
    return changed.count === 1;
  });
}
