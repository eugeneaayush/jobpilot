import { z } from "zod/v4";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.enum(["drafted", "sent", "employer_confirmed", "uncertain"]);
const storedDraft = z
  .object({
    id: z.uuid(),
    ordinal: z.union([z.literal(1), z.literal(2)]),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(5000),
    recipient: z.email().nullable(),
    createdAt: z.iso.datetime(),
    attemptId: z.uuid(),
    manifestHash: hash,
    documentSha256: hash,
    receiptSha256: hash,
    packetHash: hash,
  })
  .strict();

export const personalFollowupHistorySchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("drafted"), draft: storedDraft }).strict(),
      z
        .object({
          kind: z.enum(["sent", "employer_confirmed", "uncertain"]),
          draftId: z.uuid(),
          at: z.iso.datetime(),
          networkingMessageId: z.uuid(),
          emailMessageId: z.uuid().nullable(),
          providerId: z.string().nullable(),
          evidenceHash: hash,
        })
        .strict(),
    ]),
  )
  .max(10);

export const personalFollowupResponseSchema = z
  .object({
    recordId: z.uuid(),
    recordVersion: hash,
    eligible: z.boolean(),
    blocker: z.string().nullable(),
    availableAt: z.date().nullable(),
    quietDays: z.literal(10),
    maximumDrafts: z.literal(2),
    drafts: z
      .array(
        storedDraft.omit({ createdAt: true }).extend({
          createdAt: z.date(),
          status: state,
          lastEvidenceAt: z.date().nullable(),
        }),
      )
      .max(2),
  })
  .strict();

export const personalFollowupDraftInputSchema = z.object({ recordVersion: hash }).strict();
export const personalFollowupObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      recordVersion: hash,
      kind: z.literal("sent"),
      draftId: z.uuid(),
      networkingMessageId: z.uuid(),
    })
    .strict(),
  z
    .object({
      recordVersion: hash,
      kind: z.literal("uncertain"),
      draftId: z.uuid(),
      networkingMessageId: z.uuid(),
    })
    .strict(),
  z
    .object({
      recordVersion: hash,
      kind: z.literal("employer_confirmed"),
      draftId: z.uuid(),
      networkingMessageId: z.uuid(),
      emailMessageId: z.uuid(),
    })
    .strict(),
]);

export type PersonalFollowupHistory = z.infer<typeof personalFollowupHistorySchema>;
export type PersonalFollowupObservation = z.infer<typeof personalFollowupObservationSchema>;
