import { z } from "zod/v4";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const address = z
  .string()
  .max(254)
  .regex(
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/,
  );
const subject = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n\0]/.test(value));
export const personalApplicationEmailInputSchema = z
  .object({
    to: address,
    subject,
    body: z
      .string()
      .min(1)
      .max(30_000)
      .refine((value) => !value.includes("\0")),
    sourceQuote: z.string().min(1).max(4000),
    sourceUrl: z.url(),
  })
  .strict();
const attachmentSchema = z
  .object({
    kind: z.enum(["resume", "cover_letter"]),
    filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,100}\.pdf$/),
    mimeType: z.literal("application/pdf"),
    sha256: hash,
    bytes: z.number().int().positive().max(10_000_000),
  })
  .strict();
export const frozenApplicationEmailSchema = personalApplicationEmailInputSchema
  .extend({
    schemaVersion: z.literal(1),
    recordId: z.uuid(),
    identity: z.string().min(1),
    postingContentHash: hash,
    previewManifestHash: hash,
    verifiedCareerSourceHash: hash,
    attachments: z.array(attachmentSchema).min(1).max(5),
    payloadHash: hash,
  })
  .strict();
export const applicationEmailMimeProofSchema = z
  .object({
    messageId: z.string().regex(/^<jobpilot-[a-f0-9-]{36}@local\.jobpilot>$/),
    from: address,
    to: address,
    subjectHeader: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => !/[\r\n\0]/.test(value)),
    contentType: z.string().min(1).max(300),
    bodySha256: hash,
    mimeBodySha256: hash,
    attachments: z.array(attachmentSchema).min(1).max(5),
  })
  .strict();
export const applicationEmailTransportFreezeSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.literal("claimed"),
    claimId: z.uuid(),
    payloadHash: hash,
    mimeHash: hash,
    messageId: z.string(),
    from: address,
    dispatchStartedAt: z.iso.datetime().nullable(),
    payload: frozenApplicationEmailSchema,
    proof: applicationEmailMimeProofSchema,
  })
  .strict();
export type PersonalApplicationEmailInput = z.infer<typeof personalApplicationEmailInputSchema>;
export type FrozenApplicationEmail = z.infer<typeof frozenApplicationEmailSchema>;
export type ApplicationEmailAttachment = FrozenApplicationEmail["attachments"][number];
export type ApplicationEmailMimeProof = z.infer<typeof applicationEmailMimeProofSchema>;
