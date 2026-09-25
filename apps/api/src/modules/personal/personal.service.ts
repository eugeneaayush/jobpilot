import { readFile } from "node:fs/promises";
import path from "node:path";
import { pageSlice, paginate } from "@jobpilot/contracts/pagination";
import {
  type PersonalDashboard,
  type PersonalSettings,
  personalQuerySchema,
} from "@jobpilot/contracts/personal";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import { singleton } from "tsyringe";
import { z } from "zod/v4";
import { badRequest, conflict, notFound } from "@/common/errors";
import { PrismaClient } from "@/generated/prisma/client";
import { type IntakeOptions, intakeMaster } from "./intake";
import { privateArtifactRoot, readPrivateArtifact } from "./persistence-policy";
import { personalRecordDto } from "./personal.mapper";
import { PersonalReadinessService } from "./readiness.service";
import { resolveResumeEvidence, resumeResolutionOverlaySchema } from "./resume-evidence";
import {
  jsonValue,
  objectValue,
  personalConfiguration,
  personalRoot,
  readSettings,
  runtimeConfiguration,
  savePrivate,
  sha256,
  stringsValue,
  textValue,
} from "./runtime";

@singleton()
export class PersonalService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly readiness: PersonalReadinessService,
  ) {}

  async dashboard(
    userId: string,
    query: z.infer<typeof personalQuerySchema>,
  ): Promise<PersonalDashboard> {
    personalRoot();
    const where = { userId, ...(query.track && { track: query.track }) };
    const [rows, total, runs, evidence, attempts, readiness, settings] = await Promise.all([
      this.prisma.personalRecord.findMany({
        where,
        ...pageSlice(query),
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      }),
      this.prisma.personalRecord.count({ where }),
      this.prisma.personalDiscoveryRun.findMany({
        where: { userId },
        take: 10,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.personalResumeEvidence.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.personalAttempt.findMany({
        where: { userId },
        take: 20,
        orderBy: { updatedAt: "desc" },
        select: { id: true, recordId: true, mode: true, state: true, updatedAt: true },
      }),
      this.readiness.get(userId),
      this.settings(userId),
    ]);
    const resume = evidence
      ? await this.prisma.resume.findFirst({ where: { id: evidence.resumeId, userId } })
      : null;
    const config = await runtimeConfiguration();
    const missingSetup = readiness.blockers;
    let supervisor: PersonalDashboard["supervisor"] = null;
    if (objectValue(config.account).userId === userId) {
      try {
        const state = objectValue(
          JSON.parse(await readFile(path.join(personalRoot(), "supervisor.json"), "utf8")),
        );
        supervisor = {
          status: textValue(state.status),
          updatedAt: textValue(state.updatedAt),
          error: textValue(state.error) || null,
        };
      } catch {
        /* Supervisor not started yet. */
      }
    }
    return {
      records: paginate(
        rows.map((row) => personalRecordDto(row, evidence ? { settings, evidence } : undefined)),
        query,
        total,
      ),
      sources: runs.map((run) => {
        const details = objectValue(run.details);
        return {
          id: run.id,
          source: run.source,
          status: run.status,
          count: typeof details.count === "number" ? details.count : 0,
          error: textValue(details.error) || null,
          createdAt: run.createdAt,
        };
      }),
      resume:
        evidence && resume
          ? {
              id: resume.id,
              label: resume.label,
              sourceHash: evidence.sourceHash,
              conflicts: stringsValue(objectValue(evidence.details).conflicts),
              createdAt: evidence.createdAt,
            }
          : null,
      capabilities: {
        personalMode: readiness.personalMode,
        offlinePreview: true,
        liveSubmissions: readiness.campaignExecutionReady,
        missingSetup,
      },
      activity: attempts,
      supervisor,
    };
  }

  async intake(userId: string) {
    const config = await personalConfiguration(userId);
    const assertions = Array.isArray(config.intakeAssertions)
      ? (config.intakeAssertions as IntakeOptions["assertions"])
      : [];
    const intake = await intakeMaster(
      textValue(config.sourceJsonPath),
      textValue(config.sourceDocxPath),
      path.join(personalRoot(), "storage", userId),
      { comparisonPaths: stringsValue(config.comparisonPaths), assertions },
    );
    const sourceHash = intake.manifest.sources[0].sha256;
    const addedConflicts = z
      .array(
        z
          .object({
            kind: z.string().min(1),
            source: z.string().min(1),
            pointer: z.string().optional(),
            message: z.string().min(1),
            values: z.array(z.json()),
          })
          .strict(),
      )
      .parse(config.intakeConflicts ?? []);
    const manifest = {
      ...intake.manifest,
      conflicts: [...intake.manifest.conflicts, ...addedConflicts],
    };
    const resolution = resolveResumeEvidence({
      document: intake.data,
      sourceSha256: sourceHash,
      conflicts: manifest.conflicts,
      overlay:
        config.resumeResolutionOverlay === undefined
          ? undefined
          : resumeResolutionOverlaySchema.parse(config.resumeResolutionOverlay),
    });
    const data = resumeDataSchema.parse(resolution.document);
    const conflicts = resolution.unresolvedConflicts.map(
      ({ conflict: item }) => `${item.message}${item.pointer ? ` (${item.pointer})` : ""}`,
    );
    if (config.syntheticApplicant === true)
      conflicts.push("Synthetic applicant fixture: real submission is prohibited");
    const intakeFingerprint = sha256(
      JSON.stringify({
        sources: intake.manifest.sources.map((source) => ({
          path: source.path,
          sha256: source.sha256,
        })),
        assertions,
        addedConflicts,
        overlaySha256: resolution.provenance.overlaySha256,
        syntheticApplicant: config.syntheticApplicant === true,
      }),
    );
    const existing = await this.prisma.personalResumeEvidence.findFirst({
      where: {
        userId,
        sourceHash,
        details: { path: ["intakeFingerprint"], equals: intakeFingerprint },
      },
    });
    if (existing)
      return {
        resumeId: existing.resumeId,
        sourceHash,
        conflicts: stringsValue(objectValue(existing.details).conflicts),
      };
    const manifestPath = path.join(
      personalRoot(),
      "storage",
      userId,
      `intake-effective-${sha256(JSON.stringify(manifest))}.json`,
    );
    await savePrivate(manifestPath, manifest);
    const result = await this.prisma.$transaction(async (tx) => {
      const resume = await tx.resume.create({
        data: { userId, label: "Private MBA master", content: JSON.stringify(data) },
      });
      await tx.personalResumeEvidence.create({
        data: {
          userId,
          resumeId: resume.id,
          sourceHash,
          details: jsonValue({
            manifest,
            manifestPath,
            originalManifest: intake.manifest,
            originalManifestPath: intake.manifestPath,
            resolution,
            conflicts,
            intakeFingerprint,
          }),
        },
      });
      await tx.user.update({ where: { id: userId }, data: { primaryResumeId: resume.id } });
      return resume;
    });
    return { resumeId: result.id, sourceHash, conflicts };
  }

  settings(userId: string) {
    return readSettings(userId);
  }

  async record(userId: string, recordId: string) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const [settings, evidence] = await Promise.all([
      this.settings(userId),
      this.prisma.personalResumeEvidence.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return personalRecordDto(record, evidence ? { settings, evidence } : undefined);
  }

  async updateSettings(userId: string, settings: PersonalSettings) {
    await savePrivate(path.join(personalRoot(), "settings", `${userId}.json`), settings);
    return settings;
  }

  async resumeData(userId: string) {
    const evidence = await this.prisma.personalResumeEvidence.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (!evidence) throw badRequest("Import the configured résumé first");
    const resume = await this.prisma.resume.findFirst({ where: { id: evidence.resumeId, userId } });
    if (!resume?.content) throw notFound("Imported résumé missing");
    return { evidence, resume, data: resumeDataSchema.parse(JSON.parse(resume.content)) };
  }

  async pdf(userId: string, recordId: string): Promise<Response> {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const document = objectValue(objectValue(record.details).document);
    const file = path.resolve(textValue(document.path));
    const root = path.join(personalRoot(), "storage", userId) + path.sep;
    if (!file.startsWith(root)) throw notFound("Private PDF not found");
    const bytes = await readPrivateArtifact(file, privateArtifactRoot(userId));
    if (sha256(bytes) !== document.sha256) throw conflict("Stored PDF failed its integrity check");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="tailored-resume.pdf"',
        "cache-control": "private, no-store",
      },
    });
  }
}
