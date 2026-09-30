import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { personalTailoringResponseSchema } from "@jobpilot/contracts/personal-tailoring";
import {
  personalDocumentEditsSchema,
  personalYamlImportSchema,
} from "@jobpilot/contracts/personal-yaml";
import { singleton } from "tsyringe";
import type { z } from "zod/v4";
import { conflict, notFound } from "@/common/errors";
import { PrismaClient } from "@/generated/prisma/client";
import { postingContentHash } from "./attachments-policy";
import { resumePageLimit, seniorityParkReason } from "./graduate-policy";
import { assertRendererConfiguration } from "./local-tools/pipeline-config";
import { runLocalTool } from "./local-tools/runner";
import { privateArtifactRoot, verifyPrivateArtifact } from "./persistence-policy";
import { PersonalService } from "./personal.service";
import { jsonValue, objectValue, personalRoot, sha256 } from "./runtime";
import {
  buildTailoringInput,
  type TailoringProposal,
  tailoringHash,
  validateTailoringProposal,
} from "./tailoring/proposal";
import { localToolSourceHash } from "./yaml.structure";

@singleton()
export class PersonalYamlService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
  ) {}

  private async context(userId: string, recordId: string) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const { evidence, data } = await this.personal.resumeData(userId);
    const input = buildTailoringInput(data, {
      sourceDigest: evidence.sourceHash,
      maxPages: resumePageLimit(record),
      job: {
        identity: record.identity,
        title: record.title,
        company: record.company,
        description: String(objectValue(objectValue(record.details).posting).descriptionText ?? ""),
        postingContentHash: postingContentHash(record),
      },
    });
    return {
      record,
      data,
      input,
      recordVersion: tailoringHash({
        updatedAt: record.updatedAt.toISOString(),
        details: record.details,
        inputHash: input.inputHash,
      }),
    };
  }

  async export(userId: string, recordId: string, signal?: AbortSignal) {
    const context = await this.context(userId, recordId);
    const { result } = await runLocalTool(
      userId,
      "export_resume_yaml",
      { resume: context.data },
      { signal },
    );
    if (result.sourceSha256 !== localToolSourceHash(context.data))
      throw conflict("Local YAML export source hash mismatch");
    try {
      assertRendererConfiguration("rendercv-classic", result);
    } catch {
      throw conflict("Renderer configuration changed; install the locked tools before YAML export");
    }
    return { recordVersion: context.recordVersion, ...result };
  }

  async import(
    userId: string,
    recordId: string,
    body: z.infer<typeof personalYamlImportSchema>,
    signal?: AbortSignal,
  ) {
    const context = await this.context(userId, recordId);
    const { record, data, input } = context;
    if (body.recordVersion !== context.recordVersion)
      throw conflict("Record or source facts changed; export a fresh YAML bundle");
    if (["applying", "submitted", "submission_uncertain"].includes(record.state))
      throw conflict("Active or possibly submitted documents are immutable");
    const reason = seniorityParkReason(record);
    if (reason) throw conflict(reason);
    const details = objectValue(record.details);
    const previous = objectValue(details.tailoring);
    if (previous.status === "running" && Date.parse(String(previous.leaseExpiresAt)) > Date.now())
      throw conflict("A tailoring worker already owns this record");
    const { result } = await runLocalTool(
      userId,
      "import_resume_yaml",
      { bundleYaml: body.bundleYaml, expectedResume: data },
      { signal },
    );
    if (result.sourceSha256 !== localToolSourceHash(data) || !result.requiresIndependentReview)
      throw conflict("Local YAML import does not match the accepted source");
    const rewrites = result.operations
      .filter((operation) => operation.kind === "rephrase")
      .map((operation, index) => {
        const fact = input.facts.find((item) => item.pointer === operation.path);
        if (
          !fact?.editable ||
          operation.before !== fact.quote ||
          typeof operation.after !== "string"
        )
          throw conflict("YAML rewrite must target one unchanged source bullet");
        return {
          id: `yaml-${index}`,
          text: operation.after,
          targetFactId: fact.id,
          citations: [{ factId: fact.id, quoteSha256: fact.quoteSha256 }],
        };
      });
    let proposal: TailoringProposal;
    try {
      proposal = validateTailoringProposal(input, {
        version: 1,
        inputHash: input.inputHash,
        rewrites,
        essayClaims: [],
      });
    } catch {
      throw conflict("YAML rewrite changes an unsupported fact or frozen metric");
    }
    const edits = personalDocumentEditsSchema.parse({
      version: 1,
      baseDataHash: input.baseDataHash,
      sourceSha256: result.sourceSha256,
      sourceDigest: input.sourceDigest,
      proposalHash: tailoringHash(proposal),
      requiresIndependentReview: true,
      operations: result.operations.filter((operation) => operation.kind !== "rephrase"),
    });
    const source = await this.context(userId, recordId);
    if (source.recordVersion !== context.recordVersion)
      throw conflict("Record or source facts changed during YAML import");
    const artifact = path.join(
      personalRoot(),
      "storage",
      userId,
      "tailoring",
      `yaml-${tailoringHash({ input, proposal, edits })}.json`,
    );
    const artifactBytes = Buffer.from(JSON.stringify({ input, proposal, edits }, null, 2));
    await mkdir(path.dirname(artifact), { recursive: true, mode: 0o700 });
    await writeFile(artifact, artifactBytes, { mode: 0o600, flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await verifyPrivateArtifact(artifact, sha256(artifactBytes), privateArtifactRoot(userId));
    const tailoring = {
      status: "proposed",
      reason: null,
      input,
      proposal,
      importArtifact: artifact,
    };
    const updated = await this.prisma.personalRecord.updateMany({
      where: {
        id: recordId,
        userId,
        updatedAt: record.updatedAt,
        details: { equals: jsonValue(record.details) },
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: {
        details: jsonValue({
          ...details,
          tailoring,
          documentEdits: edits,
          preview: undefined,
          renderReview: undefined,
          document: undefined,
          preparation: undefined,
        }),
      },
    });
    if (updated.count !== 1) throw conflict("Record changed during YAML import");
    const installed = await this.context(userId, recordId);
    return {
      recordVersion: installed.recordVersion,
      sourceSha256: result.sourceSha256,
      requiresIndependentReview: true as const,
      structuralOperations: edits.operations.length,
      tailoring: personalTailoringResponseSchema.parse({
        status: "proposed",
        reason: null,
        inputHash: input.inputHash,
        proposalHash: edits.proposalHash,
        input,
        proposal,
        review: null,
      }),
    };
  }
}
