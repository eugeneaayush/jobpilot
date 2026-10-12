import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PersonalCampaignService } from "./campaign.service";
import { eligibilityContext } from "./eligibility-freshness";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { manifestHash } from "./persistence-policy";
import {
  approvePersonalFixture,
  type PersonalTestDatabase,
  personalFixture,
  refreshPersonalFixtureApproval,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalRecoveryService } from "./recovery.service";
import { jsonValue, objectValue, sha256 } from "./runtime";

export async function recoveryTransferFixture(db: PersonalTestDatabase) {
  const f = await personalFixture(db, "submit", 10);
  const r = await f.record();
  const recovery = new PersonalRecoveryService(db.prisma);
  const campaigns = new PersonalCampaignService(
    db.prisma,
    { settings: async () => f.settings } as unknown as PersonalService,
    db.service,
  );
  const create = async (board = "synthetic") =>
    campaigns.create(f.user.id, {
      name: "Synthetic recovery transfer",
      mode: "submit",
      sources: { boardTokens: [board] },
      tracks: ["mba_internship"],
      fitThreshold: 0,
      dailyCap: 10,
      maxApplications: 10,
      timezone: "America/New_York",
    });
  const original = await campaigns.launch(f.user.id, (await create()).id, true);
  const target = await campaigns.launch(f.user.id, (await create()).id, true);
  const input = {
    ...r.input,
    campaignId: original.id,
    manifest: {
      ...r.input.manifest,
      campaignRunId: original.authorization!.runId,
      campaignSnapshotHash: original.authorization!.snapshotHash,
    },
  };
  await refreshPersonalFixtureApproval(db, f.user.id, r.record.id, input.manifest, original.id);
  const attempt = await db.service.start(f.user.id, input);
  await db.service.park(
    f.user.id,
    attempt.id,
    attempt,
    "blocked",
    "Screening answers need confirmation",
  );
  const current = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: r.record.id } });
  const snapshotContent = {
    schemaVersion: 1,
    recordId: r.record.id,
    identity: r.record.identity,
    postingContentHash: manifestHash(objectValue(current.details).posting),
    settingsHash: manifestHash(f.settings),
    createdAt: new Date().toISOString(),
    answers: [],
  };
  let snapshotHash = manifestHash(snapshotContent);
  let snapshot = { ...snapshotContent, snapshotHash };
  const baseInput = {
    ...r.input,
    manifest: {
      ...r.input.manifest,
      answers: [],
      screeningAnswerSnapshot: snapshot,
      screeningAnswerSnapshotHash: snapshotHash,
    },
  };
  await db.prisma.personalRecord.update({
    where: { id: r.record.id },
    data: {
      details: jsonValue({
        ...objectValue(current.details),
        evaluation: {
          requirements: [
            {
              requirement: "Graduate recruiting",
              evidence: "This paid internship recruits MBA students.",
              status: "satisfied",
              candidateEvidence: "Synthetic verified graduate eligibility",
            },
          ],
        },
        screeningAnswers: snapshot,
      }),
    },
  });
  const evaluated = await db.prisma.personalRecord.findUniqueOrThrow({
    where: { id: r.record.id },
  });
  await db.prisma.personalRecord.update({
    where: { id: evaluated.id },
    data: {
      details: jsonValue({
        ...objectValue(evaluated.details),
        eligibilityContext: eligibilityContext(evaluated, {
          settings: f.settings,
          evidence: f.resume,
        }),
      }),
    },
  });
  const old = await db.prisma.campaign.findUniqueOrThrow({ where: { campaignId: original.id } });
  const personal = objectValue(objectValue(old.config).personal);
  await db.prisma.campaign.update({
    where: { campaignId: original.id },
    data: {
      config: jsonValue({
        ...objectValue(old.config),
        personal: {
          ...personal,
          authorization: { ...objectValue(personal.authorization), settingsHash: "0".repeat(64) },
        },
      }),
    },
  });
  const recoverInput = async (targetCampaignId = target.id) => {
    const view = await recovery.get(f.user.id, r.record.id, targetCampaignId);
    return {
      expectedUpdatedAt: view.updatedAt.toISOString(),
      context: view.context,
      attemptId: attempt.id,
      campaignRunId: view.recovery.campaignRunId ?? crypto.randomUUID(),
      targetCampaignId,
      reason: "Fresh confirmed answers resolve the original pre-submission hold",
      proof: { kind: "screening_answers" as const, snapshotHash },
    };
  };
  const prepare = async () => {
    const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: r.record.id } });
    const manifestPath = join(dirname(f.artifactPath), `${r.record.id}-transfer.json`);
    const bytes = JSON.stringify(baseInput.manifest);
    await writeFile(manifestPath, bytes);
    await db.prisma.personalRecord.update({
      where: { id: row.id },
      data: {
        state: "prepared",
        details: jsonValue({
          ...objectValue(row.details),
          eligibilityContext: eligibilityContext(row, { settings: f.settings, evidence: f.resume }),
          missingAnswers: [],
          document: {
            ...documentPipelineInputs("cbs-letter-times"),
            template: "cbs-letter-times",
            path: f.artifactPath,
            sha256: db.hash,
          },
          manifestPath,
          preview: {
            readiness: "ready",
            conflicts: [],
            renderReviewed: true,
            pdfHash: db.hash,
            manifestHash: sha256(bytes),
          },
        }),
      },
    });
    const ticket = objectValue(objectValue(row.details).recoveryTicket);
    await approvePersonalFixture(
      db,
      f.user.id,
      row.id,
      typeof ticket.campaignId === "string" ? ticket.campaignId : target.id,
    );
  };
  const refreshAnswers = async () => {
    await Bun.sleep(2);
    const content = { ...snapshotContent, createdAt: new Date().toISOString() };
    snapshotHash = manifestHash(content);
    snapshot = { ...content, snapshotHash };
    baseInput.manifest.screeningAnswerSnapshot = snapshot;
    baseInput.manifest.screeningAnswerSnapshotHash = snapshotHash;
    const row = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: r.record.id } });
    await db.prisma.personalRecord.update({
      where: { id: row.id },
      data: {
        details: jsonValue({ ...objectValue(row.details), screeningAnswers: snapshot }),
      },
    });
  };
  return {
    ...f,
    record: r.record,
    baseInput,
    recovery,
    campaigns,
    original,
    target,
    attempt,
    recoverInput,
    prepare,
    refreshAnswers,
    create,
  };
}
