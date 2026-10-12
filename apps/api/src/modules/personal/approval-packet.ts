import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type PersonalApprovalPacket,
  personalApprovalPacketSchema,
} from "@jobpilot/contracts/personal-approval";
import { conflict } from "@/common/errors";
import type { Campaign, PersonalRecord, Prisma } from "@/generated/prisma/client";
import { canonicalizeJobUrl } from "@/modules/application/job-url";
import { preparedCampaignAnswers, recordScopeParkReason } from "./campaign-policy";
import {
  manifestHash,
  privateArtifactRoot,
  readAttemptPolicy,
  readPrivateArtifact,
  trustedRequisition,
  verifyPrivateArtifact,
} from "./persistence-policy";
import { jsonValue, objectValue, readSettings, sha256, textValue } from "./runtime";
import { employerIdentity, userPolicy } from "./user-policy";

export async function buildApprovalPacket(
  tx: Prisma.TransactionClient,
  userId: string,
  record: PersonalRecord,
  campaign: Campaign,
) {
  const policy = readAttemptPolicy(campaign.config);
  if (campaign.status !== "in_progress") throw conflict("Campaign is no longer active");
  if (policy.mode === "offline")
    throw conflict("An active live campaign is required for application approval");
  const personal = objectValue(objectValue(campaign.config).personal);
  if (personal.approvalPolicy !== "per-application-v1")
    throw conflict("Relaunch this campaign under the per-application approval policy");
  const authorization = objectValue(personal.authorization);
  if (typeof authorization.runId !== "string" || typeof authorization.snapshotHash !== "string")
    throw conflict("Current campaign launch authorization is missing");
  const scopeReason = recordScopeParkReason(record, policy);
  if (scopeReason) throw conflict(scopeReason);
  const settings = await readSettings(userId);
  if (authorization.settingsHash !== manifestHash(settings))
    throw conflict("Recruiting settings changed since campaign authorization");
  const details = objectValue(record.details);
  const preview = objectValue(details.preview);
  const bytes = await readPrivateArtifact(
    textValue(details.manifestPath),
    privateArtifactRoot(userId),
  );
  if (sha256(bytes) !== preview.manifestHash)
    throw conflict("Prepared manifest hash does not match the preview");
  let prepared: Record<string, unknown>;
  try {
    prepared = objectValue(JSON.parse(bytes.toString()));
  } catch {
    throw conflict("Prepared manifest is invalid");
  }
  const document = objectValue(prepared.document);
  if (
    prepared.recordId !== record.id ||
    prepared.resumeEvidenceId !== authorization.resumeEvidenceId ||
    prepared.sourceHash !== authorization.sourceHash ||
    document.sha256 !== preview.pdfHash
  )
    throw conflict("Prepared document is outside the authorized resume snapshot");
  await verifyPrivateArtifact(
    textValue(document.path),
    textValue(document.sha256),
    privateArtifactRoot(userId),
  );
  const preparedManifest = {
    ...prepared,
    answers: preparedCampaignAnswers(prepared.answers),
    campaignRunId: authorization.runId,
    campaignSnapshotHash: authorization.snapshotHash,
    previewMode: policy.mode,
    readiness: { eligibility: "eligible", document: "ready", answers: "ready" },
  };
  const requisition = trustedRequisition(record, await employerIdentity(tx, userId, record));
  const evidence: Record<string, unknown> = {};
  for (const key of [
    "posting",
    "eligibility",
    "eligibilityAdjudication",
    "missingAnswers",
    "screeningAnswers",
    "attachmentRequirements",
    "attachments",
    "previewAttachments",
    "preview",
    "document",
    "documentVerification",
    "renderReview",
    "tailoring",
    "applicationEmail",
  ])
    evidence[key] = details[key] ?? null;
  evidence.requisition = requisition;
  return personalApprovalPacketSchema.parse({
    schemaVersion: 1,
    recordId: record.id,
    identity: record.identity,
    title: record.title,
    company: record.company,
    destination: canonicalizeJobUrl(record.url),
    requisitionId: record.requisitionId,
    campaignId: campaign.campaignId,
    campaignRunId: authorization.runId,
    campaignSnapshotHash: authorization.snapshotHash,
    settingsHash: manifestHash(settings),
    userPolicyHash: manifestHash(await userPolicy(tx, userId)),
    policyHash: manifestHash(policy),
    preparedManifest: jsonValue(preparedManifest),
    evidence: jsonValue(evidence),
  });
}

export async function saveApprovalPacket(userId: string, packet: PersonalApprovalPacket) {
  const packetHash = manifestHash(packet);
  const directory = join(privateArtifactRoot(userId), "approvals");
  const path = join(directory, `${packetHash}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, JSON.stringify(packet, null, 2), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const bytes = await readPrivateArtifact(path, privateArtifactRoot(userId));
  if (manifestHash(JSON.parse(bytes.toString())) !== packetHash)
    throw conflict("Stored approval packet differs from the reviewed packet");
  return { path, sha256: sha256(bytes) };
}
