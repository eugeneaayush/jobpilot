import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const personalApprovalReceiptSchema = z
  .object({
    id: z.uuid(),
    recordId: z.uuid(),
    campaignId: z.uuid(),
    campaignRunId: z.uuid(),
    packetHash: hash,
    packetArtifact: z.object({ path: z.string().min(1).max(2000), sha256: hash }).strict(),
    approvedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    approvedRecordVersion: z.iso.datetime(),
  })
  .strict();
export const personalApprovalEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approved"), receipt: personalApprovalReceiptSchema }).strict(),
  z
    .object({
      kind: z.literal("bound"),
      approvalId: z.uuid(),
      attemptId: z.uuid(),
      at: z.iso.datetime(),
    })
    .strict(),
  z.object({ kind: z.literal("withdrawn"), approvalId: z.uuid(), at: z.iso.datetime() }).strict(),
]);
export const personalApprovalInputSchema = z
  .object({
    expectedRecordVersion: z.iso.datetime(),
    packetHash: hash,
    nonce: z.string().min(1).max(2000),
    confirm: z.literal(true),
  })
  .strict();
export const personalApprovalWithdrawSchema = personalApprovalInputSchema.extend({
  recordId: z.uuid(),
});
export const personalApprovalPacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordId: z.uuid(),
    identity: z.string(),
    title: z.string(),
    company: z.string(),
    destination: z.url(),
    requisitionId: z.string().nullable(),
    campaignId: z.uuid(),
    campaignRunId: z.uuid(),
    campaignSnapshotHash: hash,
    settingsHash: hash,
    userPolicyHash: hash,
    policyHash: hash,
    preparedManifest: z.record(z.string(), z.json()),
    evidence: z.record(z.string(), z.json()),
  })
  .strict();
export const personalApprovalResponseSchema = z.object({
  recordId: z.uuid(),
  recordVersion: z.date(),
  packet: personalApprovalPacketSchema.nullable(),
  packetHash: hash,
  blockers: z.array(z.string()),
  nonce: z.string(),
  approval: z
    .object({
      id: z.uuid(),
      status: z.enum(["approved", "bound", "withdrawn", "expired", "stale"]),
      approvedAt: z.date(),
      expiresAt: z.date(),
      attemptId: z.uuid().nullable(),
    })
    .nullable(),
});
export type PersonalApprovalReceipt = z.infer<typeof personalApprovalReceiptSchema>;
export type PersonalApprovalEvent = z.infer<typeof personalApprovalEventSchema>;
export type PersonalApprovalPacket = z.infer<typeof personalApprovalPacketSchema>;
export type PersonalApprovalInput = z.infer<typeof personalApprovalInputSchema>;
