import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  type PersonalAttachment,
  type PersonalAttachmentRequirement,
  type PersonalAttachmentRequirements,
  personalAttachmentRequirementsSchema,
  personalAttachmentSchema,
} from "@jobpilot/contracts/personal-attachments";
import { z } from "zod/v4";
import { conflict } from "@/common/errors";
import type { PersonalRecord, Prisma } from "@/generated/prisma/client";
import { documentPipelineMatches, verifierPipelineMatches } from "./local-tools/pipeline-config";
import {
  manifestHash,
  privateArtifactRoot,
  readPrivateArtifact,
  verifyPrivateArtifact,
} from "./persistence-policy";
import { objectValue, sha256 } from "./runtime";

function verifiedDocument(document: PersonalAttachment) {
  return (
    document.verification?.status === "passed" &&
    documentPipelineMatches(document.pipeline, "cbs-cover-letter") &&
    verifierPipelineMatches(document.verification, "cbs-cover-letter") &&
    document.verification.artifactSha256 === document.sha256
  );
}

type RecordContext = Pick<PersonalRecord, "id" | "identity" | "details">;
export const postingContentHash = (record: RecordContext) => {
  const posting = objectValue(objectValue(record.details).posting);
  return typeof posting.contentHash === "string" ? posting.contentHash : manifestHash(posting);
};

const fieldKind = (
  name: string,
  label: string,
  resumeUpload = false,
): PersonalAttachmentRequirement["kind"] => {
  if (/cover[\s_-]*letter/i.test(`${name} ${label}`)) return "cover_letter";
  if (resumeUpload || /(^|[\s_/-])(resume|cv)([\s_/-]|$)/i.test(`${name} ${label}`))
    return "resume";
  return "other";
};
function uniqueRequirements(requirements: PersonalAttachmentRequirement[]) {
  if (new Set(requirements.map((item) => item.fieldName)).size !== requirements.length)
    throw conflict("Attachment field identities are ambiguous");
  return requirements.sort((a, b) => a.fieldName.localeCompare(b.fieldName));
}

export function greenhouseAttachmentRequirements(raw: unknown, nativeId: string) {
  const parsed = z
    .object({
      id: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]),
      questions: z
        .array(
          z.object({
            label: z.string().max(1000),
            required: z.boolean(),
            fields: z
              .array(z.object({ name: z.string().min(1).max(300), type: z.string().max(40) }))
              .max(30),
          }),
        )
        .max(500),
    })
    .safeParse(raw);
  if (!parsed.success || String(parsed.data.id) !== nativeId)
    throw conflict("Public job questions are absent, invalid, or for another requisition");
  return uniqueRequirements(
    parsed.data.questions.flatMap((question) =>
      question.fields
        .filter((field) => field.type === "input_file" || field.type === "file")
        .map((field) => ({
          fieldName: field.name,
          label: question.label,
          required: question.required,
          kind: fieldKind(field.name, question.label),
        })),
    ),
  );
}

export function storedAttachments(details: unknown): PersonalAttachment[] {
  return z
    .array(personalAttachmentSchema)
    .max(100)
    .parse(objectValue(details).attachments ?? []);
}
export function storedRequirements(record: RecordContext): PersonalAttachmentRequirements | null {
  const value = objectValue(record.details).attachmentRequirements;
  if (!value) return null;
  const inventory = personalAttachmentRequirementsSchema.parse(value);
  if (
    inventory.identity !== record.identity ||
    inventory.postingContentHash !== postingContentHash(record)
  )
    throw conflict(
      "Attachment requirements belong to an earlier posting; refresh the requirements",
    );
  return inventory;
}

export async function observedAttachmentRequirements(
  db: Pick<Prisma.TransactionClient, "personalAttempt">,
  userId: string,
  record: RecordContext,
): Promise<PersonalAttachmentRequirements | null> {
  const attempts = await db.personalAttempt.findMany({
    where: { userId, recordId: record.id },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, manifest: true },
  });
  const root = privateArtifactRoot(userId);
  for (const attempt of attempts) {
    const manifest = objectValue(attempt.manifest);
    if (
      manifest.identity !== record.identity ||
      manifest.postingContentHash !== postingContentHash(record)
    )
      continue;
    const path = join(root, "inspections", `${attempt.id}.json`);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    const bytes = await readPrivateArtifact(path, root);
    if (bytes.length > 512_000) throw conflict("Private inspection exceeds the question limit");
    const inspected = z
      .object({
        attemptId: z.literal(attempt.id),
        fields: z
          .array(
            z.object({
              name: z.string().max(300),
              label: z.string().max(1000),
              type: z.string().max(40),
              required: z.boolean(),
              resumeUpload: z.boolean().optional(),
            }),
          )
          .max(500),
      })
      .safeParse(JSON.parse(bytes.toString("utf8")));
    if (!inspected.success) throw conflict("Private inspection has invalid file metadata");
    const inspectionHash = sha256(bytes);
    const frozenPath = join(root, "inspections", `${inspectionHash}.json`);
    await verifyPrivateArtifact(frozenPath, inspectionHash, root);
    const requirements = uniqueRequirements(
      inspected.data.fields
        .filter((field) => field.type === "file")
        .map((field) => {
          if (!field.name) throw conflict("An observed file input has no stable field identity");
          return {
            fieldName: field.name,
            label: field.label,
            required: field.required,
            kind: fieldKind(field.name, field.label, field.resumeUpload),
          };
        }),
    );
    return {
      schemaVersion: 1,
      identity: record.identity,
      postingContentHash: postingContentHash(record),
      source: {
        kind: "broker_inspection",
        attemptId: attempt.id,
        path: frozenPath,
        sha256: inspectionHash,
        capturedAt: stat.mtime.toISOString(),
      },
      requirements,
    };
  }
  return null;
}

export function attachmentStatus(
  inventory: PersonalAttachmentRequirements | null,
  documents: PersonalAttachment[],
) {
  const missingRequired =
    inventory?.requirements
      .filter(
        (field) =>
          field.required &&
          field.kind !== "resume" &&
          !documents.some(
            (document) =>
              attachmentMatches(document, field, inventory) &&
              document.review?.pdfHash === document.sha256 &&
              verifiedDocument(document),
          ),
      )
      .map((field) => field.label || field.fieldName) ?? [];
  const unreviewed = documents.some(
    (document) =>
      document.review?.pdfHash !== document.sha256 ||
      !verifiedDocument(document) ||
      !inventory?.requirements.some((field) => attachmentMatches(document, field, inventory)),
  );
  let readiness: "unknown" | "draft" | "ready" = "unknown";
  if (inventory) readiness = missingRequired.length || unreviewed ? "draft" : "ready";
  return {
    missingRequired,
    readiness,
  };
}
function attachmentMatches(
  document: PersonalAttachment,
  field: PersonalAttachmentRequirement,
  inventory: PersonalAttachmentRequirements,
) {
  return (
    document.identity === inventory.identity &&
    document.postingContentHash === inventory.postingContentHash &&
    document.fieldName === field.fieldName &&
    document.label === field.label &&
    document.required === field.required &&
    document.kind === field.kind
  );
}

export async function verifyAttachmentManifest(
  db: Pick<Prisma.TransactionClient, "personalAttempt">,
  userId: string,
  record: RecordContext,
  manifest: unknown,
  requireReady: boolean,
  evidence?: { id: string; sourceHash: string; resumeDataHash?: string },
) {
  const object = objectValue(manifest);
  const documents = storedAttachments(record.details);
  const frozen = z.array(personalAttachmentSchema).safeParse(object.attachments ?? []);
  if (!frozen.success || manifestHash(frozen.data) !== manifestHash(documents))
    throw conflict("Attempt attachments differ from the saved record");
  const inventory = storedRequirements(record);
  if (manifestHash(object.attachmentRequirements ?? null) !== manifestHash(inventory))
    throw conflict("Attempt attachment requirements differ from the saved record");
  if (inventory) {
    await verifyPrivateArtifact(
      inventory.source.path,
      inventory.source.sha256,
      privateArtifactRoot(userId),
    );
    const observed = await observedAttachmentRequirements(db, userId, record);
    if (
      observed &&
      observed.source.capturedAt > inventory.source.capturedAt &&
      manifestHash(observed.requirements) !== manifestHash(inventory.requirements)
    )
      throw conflict(
        "Employer file requirements changed after preview; refresh and review attachments",
      );
  }
  if (requireReady && attachmentStatus(inventory, documents).readiness !== "ready")
    throw conflict(
      "Required attachments or their rendered reviews are incomplete; inspect the employer requirements",
    );
  for (const document of documents) {
    if (
      evidence &&
      (document.source.resumeEvidenceId !== evidence.id ||
        document.source.sourceHash !== evidence.sourceHash ||
        (evidence.resumeDataHash !== undefined &&
          document.source.resumeDataHash !== evidence.resumeDataHash))
    )
      throw conflict("Attachment resume evidence changed; regenerate and review the attachment");
    if (requireReady && document.review?.reviewer !== userId)
      throw conflict("Attachment must be reviewed by its owner");
    await verifyPrivateArtifact(document.path, document.sha256, privateArtifactRoot(userId));
    if (requireReady) {
      const reportHash = sha256(JSON.stringify(document.verification, null, 2));
      await verifyPrivateArtifact(
        join(privateArtifactRoot(userId), "document-checks", `${reportHash}.json`),
        reportHash,
        privateArtifactRoot(userId),
      );
    }
  }
}
