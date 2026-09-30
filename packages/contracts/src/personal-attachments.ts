import { z } from "zod/v4";
import { personalDocumentVerificationSchema } from "./personal-local-tools";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const personalAttachmentRequirementSchema = z.object({
  fieldName: z.string().min(1).max(300),
  label: z.string().max(1000),
  required: z.boolean(),
  kind: z.enum(["resume", "cover_letter", "other"]),
});
const sourceBase = { sha256: hash, path: z.string().min(1), capturedAt: z.iso.datetime() };
export const personalAttachmentRequirementsSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z.string().min(1),
  postingContentHash: hash,
  source: z.discriminatedUnion("kind", [
    z.object({ ...sourceBase, kind: z.literal("greenhouse_questions"), url: z.url() }),
    z.object({ ...sourceBase, kind: z.literal("broker_inspection"), attemptId: z.uuid() }),
  ]),
  requirements: z.array(personalAttachmentRequirementSchema).max(500),
});
const personalAttachmentReviewSchema = z.object({
  pdfHash: hash,
  inspected: z.literal(true),
  notes: z.string().max(4000),
  reviewedAt: z.iso.datetime(),
  reviewer: z.uuid(),
});
export const personalAttachmentSchema = personalAttachmentRequirementSchema.extend({
  id: z.uuid(),
  kind: z.literal("cover_letter"),
  identity: z.string().min(1),
  postingContentHash: hash,
  path: z.string().min(1),
  sha256: hash,
  bytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  source: z.object({
    resumeEvidenceId: z.uuid(),
    sourceHash: hash,
    resumeDataHash: hash,
    citations: z.array(z.object({ pointer: z.string().startsWith("/"), value: z.string() })).min(1),
  }),
  review: personalAttachmentReviewSchema.nullable(),
  verification: personalDocumentVerificationSchema.optional(),
  pipeline: z
    .object({
      documentPipelineVersion: z.string(),
      renderer: z.literal("cbs-cover-letter"),
      rendererVersion: z.string(),
      rendererConfigHash: hash,
      verifierVersion: z.literal("1"),
      verifierConfigHash: hash,
    })
    .strict()
    .optional(),
});
export const personalCoverLetterInputSchema = z
  .object({
    fieldName: z.string().min(1).max(300),
  })
  .strict();
export const personalAttachmentReviewInputSchema = z
  .object({
    attachmentId: z.uuid(),
    pdfHash: hash,
    inspected: z.literal(true),
    notes: z.string().max(4000).default(""),
  })
  .strict();
export const personalAttachmentsResponseSchema = z.object({
  recordId: z.uuid(),
  updatedAt: z.date(),
  requirements: z.array(personalAttachmentRequirementSchema),
  requirementsSource: z
    .object({
      kind: z.enum(["greenhouse_questions", "broker_inspection"]),
      sha256: hash,
      capturedAt: z.date(),
      url: z.url().optional(),
      attemptId: z.uuid().optional(),
    })
    .nullable(),
  documents: z.array(
    personalAttachmentSchema.omit({ path: true }).extend({
      createdAt: z.date(),
      pdfUrl: z.string(),
      review: personalAttachmentReviewSchema.extend({ reviewedAt: z.date() }).nullable(),
    }),
  ),
  missingRequired: z.array(z.string()),
  readiness: z.enum(["unknown", "draft", "ready"]),
  requiresPreview: z.boolean(),
});
export type PersonalAttachment = z.infer<typeof personalAttachmentSchema>;
export type PersonalAttachmentRequirements = z.infer<typeof personalAttachmentRequirementsSchema>;
export type PersonalAttachmentRequirement = z.infer<typeof personalAttachmentRequirementSchema>;
export type PersonalAttachmentReviewInput = z.infer<typeof personalAttachmentReviewInputSchema>;
