import { join } from "node:path";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import {
  type PersonalReadiness,
  type PersonalScreeningAnswersInput,
  personalScreeningAnswersResponseSchema,
  personalScreeningSnapshotSchema,
} from "@jobpilot/contracts/personal-readiness";
import { singleton } from "tsyringe";
import { z } from "zod/v4";
import { conflict, notFound } from "@/common/errors";
import { env } from "@/env";
import { type PersonalRecord, type Prisma, PrismaClient } from "@/generated/prisma/client";
import { screeningSuggestions } from "./answers-policy";
import { postingContentHash, storedRequirements } from "./attachments-policy";
import { manifestHash, privateArtifactRoot, readPrivateArtifact } from "./persistence-policy";
import {
  answeredScreeningFields,
  missingPersonalSettings,
  probeTerminalReadiness,
} from "./readiness-policy";
import {
  adjudicatedRequirements,
  overallEligibility,
  recoveryContext,
  recoveryRequirements,
} from "./recovery-policy";
import {
  jsonValue,
  objectValue,
  readSettings,
  runtimeConfiguration,
  sha256,
  stringsValue,
  textValue,
} from "./runtime";
import { validateScreeningAnswerSources } from "./screening-provenance";

@singleton()
export class PersonalReadinessService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(userId: string, bearer?: string): Promise<PersonalReadiness> {
    const checkedAt = new Date();
    const privateMode = env.PERSONAL_MODE && Boolean(env.JOBPILOT_PERSONAL_ROOT);
    const [evidence, configuration, settingsResult] = await Promise.all([
      this.prisma.personalResumeEvidence.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      privateMode ? runtimeConfiguration().catch(() => null) : Promise.resolve(null),
      privateMode ? readSettings(userId).catch(() => null) : Promise.resolve(null),
    ]);
    const config = objectValue(configuration);
    const account = objectValue(config.account);
    const callerToken = bearer?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const localToken = account.userId === userId ? textValue(account.token) : "";
    const terminal = await probeTerminalReadiness(
      privateMode ? callerToken || localToken || null : null,
    );
    const scope = terminal.providerApproved ? (terminal.providerApprovalScope ?? "none") : "none";
    const rawConflicts = objectValue(evidence?.details).conflicts;
    const conflicts = stringsValue(rawConflicts);
    if (evidence && !Array.isArray(rawConflicts))
      conflicts.push("Resume evidence does not contain a reviewed conflict list");
    const resume = {
      status: !evidence
        ? ("missing" as const)
        : conflicts.length
          ? ("conflicted" as const)
          : ("ready" as const),
      evidenceId: evidence?.id ?? null,
      sourceHash: evidence?.sourceHash ?? null,
      conflicts,
    };
    const blockers: string[] = [];
    if (!privateMode || !configuration)
      blockers.push("Private runtime is not configured or readable");
    if (!settingsResult) blockers.push("Private recruiting settings are unavailable");
    if (scope === "none")
      blockers.push(
        terminal.providerApprovalBlockReason ||
          "Configured provider scope and file hashes have not been verified by the local terminal",
      );
    if (resume.status === "missing") blockers.push("Import the configured resume evidence");
    if (resume.status === "conflicted")
      blockers.push("Resolve the recorded resume-source conflicts");
    if (terminal.status !== "available")
      blockers.push(terminal.blockReason || "Local terminal is unavailable");
    if (terminal.status === "available") {
      if (!terminal.structuredTasks || !terminal.brokerConfigured)
        blockers.push("Structured workers or scoped browser broker are unavailable");
      if (!terminal.codexSupervisorEnabled)
        blockers.push(terminal.blockReason || "Codex supervision is unavailable");
      for (const id of ["codex", "claude"])
        if (!terminal.providers.some((provider) => provider.id === id && provider.installed))
          blockers.push(`${id} executable is unavailable`);
    }
    return {
      checkedAt,
      personalMode: privateMode,
      providerApproval: { approved: scope !== "none", scope },
      resume,
      terminal,
      browser: {
        status: "needs_per_job",
        reason:
          "Each job still requires live form, login, challenge, required-field, and final-review checks",
      },
      missingSettings: missingPersonalSettings(settingsResult ?? personalSettingsSchema.parse({})),
      blockers,
      campaignExecutionReady: blockers.length === 0,
    };
  }

  async answers(userId: string, recordId: string) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Personal record not found");
    const value = objectValue(record.details).screeningAnswers;
    const snapshot = value ? personalScreeningSnapshotSchema.parse(value) : null;
    const questions = await this.observedQuestions(userId, recordId);
    const settings = await readSettings(userId);
    return {
      recordId,
      updatedAt: record.updatedAt,
      snapshot,
      requiresPreview: Boolean(snapshot),
      questions,
      suggestions: screeningSuggestions(
        questions,
        settings,
        textValue(objectValue(objectValue(record.details).posting).location) || null,
      ),
    };
  }

  async saveAnswers(userId: string, recordId: string, input: PersonalScreeningAnswersInput) {
    const settings = await readSettings(userId);
    const settingsHash = manifestHash(settings);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const record = await tx.personalRecord.findFirst({ where: { id: recordId, userId } });
      if (!record) throw notFound("Personal record not found");
      if (record.updatedAt.toISOString() !== input.expectedUpdatedAt)
        throw conflict("Record changed; reload it before replacing screening answers");
      if (["applying", "submitted", "submission_uncertain"].includes(record.state))
        throw conflict("Cannot replace answers for an active or possibly submitted application");
      const active = await tx.personalAttempt.count({
        where: {
          userId,
          recordId,
          state: { in: ["preparing", "prepared", "submitting", "submission_uncertain"] },
        },
      });
      if (active)
        throw conflict("Stop or resolve the active attempt before replacing screening answers");
      const details = objectValue(record.details);
      const posting = objectValue(details.posting);
      const evidence = await tx.personalResumeEvidence.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      validateScreeningAnswerSources(
        input.answers,
        settings,
        evidence,
        textValue(posting.location) || null,
      );
      const content = {
        schemaVersion: 1 as const,
        recordId,
        identity: record.identity,
        postingContentHash:
          typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting),
        settingsHash,
        createdAt: new Date().toISOString(),
        answers: input.answers,
      };
      const snapshot = { ...content, snapshotHash: manifestHash(content) };
      const history = Array.isArray(details.screeningAnswerSnapshots)
        ? details.screeningAnswerSnapshots
        : [];
      if (history.length >= 100)
        throw conflict("This record reached its 100 immutable screening-answer snapshots");
      const questions = await this.questionsForRecord(record, tx);
      const currentDetails = { ...details, screeningAnswers: snapshot };
      const requirements = evidence
        ? adjudicatedRequirements(currentDetails, recoveryContext(record, settings, evidence))
        : recoveryRequirements(details);
      const unknownRequirements = requirements
        .filter((requirement) => requirement.status === "unknown")
        .map((requirement) => requirement.requirement);
      const answeredFields = answeredScreeningFields(input.answers, questions);
      const answered = (fieldName: string) => answeredFields.has(fieldName);
      const employerQuestions = questions.filter(
        (question) => !["file", "input_file"].includes(question.type),
      );
      const labelOf = (question: (typeof questions)[number]) =>
        question.label || question.fieldName;
      const answeredLabels = new Set(
        employerQuestions
          .filter(
            (question) =>
              answered(question.fieldName) &&
              employerQuestions
                .filter((other) => labelOf(other) === labelOf(question))
                .every((other) => answered(other.fieldName)),
          )
          .map(labelOf),
      );
      const missingAnswers = [
        ...new Set([
          ...stringsValue(details.missingAnswers).filter(
            (label) => !answeredLabels.has(label) || unknownRequirements.includes(label),
          ),
          ...unknownRequirements,
          ...employerQuestions
            .filter((question) => question.required && !answered(question.fieldName))
            .map(labelOf),
        ]),
      ];
      const preview = objectValue(details.preview);
      const nextDetails = {
        ...details,
        screeningAnswers: snapshot,
        screeningAnswerSnapshots: [...history, snapshot],
        missingAnswers,
        ...(details.eligibilityAdjudication
          ? {
              eligibility: {
                decision: overallEligibility(requirements),
                reasons: requirements.map(
                  (requirement) =>
                    `${requirement.status}: ${requirement.requirement} — ${requirement.evidence}`,
                ),
              },
            }
          : {}),
        ...(details.preview
          ? {
              preview: { ...preview, readiness: "draft", renderReviewed: false },
            }
          : {}),
      };
      const changed = await tx.personalRecord.updateMany({
        where: { id: recordId, userId, updatedAt: record.updatedAt },
        data: { details: jsonValue(nextDetails) },
      });
      if (changed.count !== 1)
        throw conflict("Record changed while screening answers were verified");
      const updated = await tx.personalRecord.findUniqueOrThrow({ where: { id: recordId } });
      return { recordId, updatedAt: updated.updatedAt, snapshot, requiresPreview: true, questions };
    });
    return result;
  }

  private async observedQuestions(userId: string, recordId: string) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Personal record not found");
    return this.questionsForRecord(record, this.prisma);
  }

  private async questionsForRecord(
    record: PersonalRecord,
    db: Pick<Prisma.TransactionClient, "personalAttempt">,
  ): Promise<z.infer<typeof personalScreeningAnswersResponseSchema>["questions"]> {
    const userId = record.userId;
    const recordId = record.id;
    const inventory = storedRequirements(record);
    if (inventory?.source.kind === "greenhouse_questions") {
      const bytes = await readPrivateArtifact(inventory.source.path, privateArtifactRoot(userId));
      if (sha256(bytes) !== inventory.source.sha256)
        throw conflict("Public screening-question snapshot hash mismatch");
      const source = z
        .object({
          id: z.union([z.string(), z.number()]),
          questions: z
            .array(
              z.object({
                label: z.string().max(1000),
                required: z.boolean(),
                fields: z
                  .array(
                    z.object({
                      name: z.string().max(300),
                      type: z.string().max(40),
                      values: z
                        .array(
                          z.object({
                            value: z.union([z.string(), z.number()]),
                            label: z.string().max(1000),
                          }),
                        )
                        .max(1000)
                        .optional(),
                    }),
                  )
                  .max(30),
              }),
            )
            .max(500),
        })
        .parse(JSON.parse(bytes.toString()));
      if (String(source.id) !== record.requisitionId)
        throw conflict("Screening questions belong to another requisition");
      return source.questions
        .filter(
          (question) =>
            !question.fields.some((field) => ["input_file", "file"].includes(field.type)),
        )
        .flatMap((question) =>
          question.fields
            .filter((field) => !["input_file", "file"].includes(field.type))
            .map((field) => ({
              fieldName: field.name,
              type: field.type,
              ...(["multi_value_single_select", "multi_value_multi_select"].includes(field.type)
                ? {
                    multiple: field.type === "multi_value_multi_select",
                    options: field.values?.map((option) => ({
                      value: String(option.value),
                      label: option.label,
                    })),
                  }
                : {}),
              label: question.label,
              required: question.required,
            })),
        )
        .slice(0, 500);
    }
    const attempt = await db.personalAttempt.findFirst({
      where: { userId, recordId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { id: true, manifest: true },
    });
    if (
      !attempt ||
      objectValue(attempt.manifest).identity !== record.identity ||
      objectValue(attempt.manifest).postingContentHash !== postingContentHash(record)
    )
      return [];
    let bytes: Buffer;
    try {
      const root = privateArtifactRoot(userId);
      bytes = await readPrivateArtifact(join(root, "inspections", `${attempt.id}.json`), root);
    } catch {
      return []; // Absent, unavailable or unsafe artifacts never become questions.
    }
    if (bytes.length > 512_000) throw conflict("Private inspection exceeds the question limit");
    let contents: unknown;
    try {
      contents = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw conflict("Private inspection has invalid question metadata");
    }
    const inspection = z
      .object({
        attemptId: z.literal(attempt.id),
        fields: z
          .array(
            z.object({
              name: z.string().max(300),
              label: z.string().max(1000),
              type: z.string().max(40),
              required: z.boolean(),
              multiple: z.boolean().optional(),
              options: z.array(z.string().max(1000)).max(1000).optional(),
            }),
          )
          .max(500),
      })
      .safeParse(contents);
    if (!inspection.success) throw conflict("Private inspection has invalid question metadata");
    return inspection.data.fields.map(({ name, options, multiple, ...field }) => ({
      fieldName: name,
      ...field,
      ...(field.type === "select"
        ? {
            multiple: multiple ?? false,
            options: options?.map((value) => ({ value, label: value })),
          }
        : {}),
    }));
  }
}
