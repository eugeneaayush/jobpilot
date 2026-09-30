import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { personalDocumentVerificationSchema } from "@jobpilot/contracts/personal-local-tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { env } from "@/env";
import { PrismaClient } from "@/generated/prisma/client";
import { PersonalApprovalService } from "./approval.service";
import { PersonalAttemptService } from "./attempt.service";
import { eligibilityContext } from "./eligibility-freshness";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { manifestHash } from "./persistence-policy";
import { jsonValue, objectValue } from "./runtime";

export async function createPersonalTestDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error(
      "Personal integration tests require an explicitly configured local test database.",
    );
  const schema = `personal_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const client = await admin.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}", public`);
  try {
    const migrations = join(import.meta.dir, "../../..", "prisma/migrations");
    for (const name of (await readdir(migrations)).sort()) {
      if (!/^\d/.test(name)) continue;
      await client.query(await readFile(join(migrations, name, "migration.sql"), "utf8"));
    }
  } finally {
    client.release();
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString, options: `-c search_path=${schema},public`, max: 10 },
      { schema },
    ),
  });
  const dir = await mkdtemp(join(tmpdir(), "jobpilot-attempt-test-"));
  const originalRoot = process.env.JOBPILOT_PERSONAL_ROOT;
  const originalRuntime = {
    PERSONAL_MODE: env.PERSONAL_MODE,
    JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
  };
  env.PERSONAL_MODE = true;
  env.JOBPILOT_PERSONAL_ROOT = dir;
  process.env.JOBPILOT_PERSONAL_ROOT = dir;
  await writeFile(join(dir, "runtime.json"), JSON.stringify({ candidate: {} }), { mode: 0o600 });
  const artifactPath = join(dir, "receipt.txt");
  const bytes = "Synthetic employer confirmation artifact for automated tests only.";
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    prisma,
    service: new PersonalAttemptService(prisma),
    artifactPath,
    root: dir,
    hash,
    async dispose() {
      await prisma.$disconnect();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
      Object.assign(env, originalRuntime);
      if (originalRoot === undefined) delete process.env.JOBPILOT_PERSONAL_ROOT;
      else process.env.JOBPILOT_PERSONAL_ROOT = originalRoot;
    },
  };
}

export type PersonalTestDatabase = Awaited<ReturnType<typeof createPersonalTestDatabase>>;

export async function personalFixture(
  db: PersonalTestDatabase,
  mode: "submit" | "offline" = "submit",
  dailyCap = 3,
  approve = true,
) {
  const user = await db.prisma.user.create({
    data: { email: `${crypto.randomUUID()}@example.test`, username: crypto.randomUUID() },
  });
  // Fixtures own isolated settings; they never consume a configured applicant's global fallback.
  await mkdir(join(db.root, "settings"), { recursive: true, mode: 0o700 });
  const settings = personalSettingsSchema.parse({
    recruitingAvailability: {
      partTimeNow: true,
      partTimeMaxHours: 20,
      partTimeLocations: ["NYC", "US remote"],
      internshipStartMonth: "2027-05",
      internshipEndMonth: "2027-09",
      permanentStartMonth: "2028-05",
      paidOnly: true,
      englishSufficientOnly: true,
      employerSupportedInternational: true,
      unrestrictedTravelRelocation: true,
    },
    workAuthorization: true,
    workAuthorizationCountries: ["US"],
    citizenship: "US",
  });
  await writeFile(join(db.root, "settings", `${user.id}.json`), JSON.stringify(settings), {
    mode: 0o600,
  });
  const artifactPath = join(db.root, "storage", user.id, "receipt.txt");
  await mkdir(join(db.root, "storage", user.id), { recursive: true, mode: 0o700 });
  await writeFile(artifactPath, await readFile(db.artifactPath), { mode: 0o600 });
  let campaign = await db.prisma.campaign.create({
    data: {
      userId: user.id,
      query: "Synthetic test",
      source: "apply",
      config: {
        personal: {
          enabled: true,
          approvalPolicy: "per-application-v1",
          tracks: ["mba_internship"],
          sources: { boardTokens: ["synthetic"] },
          mode,
          dailyCap,
          maxApplications: 10,
          timezone: "America/New_York",
          policyVersion: "test-v1",
        },
      },
    },
  });
  const resume = await db.prisma.personalResumeEvidence.create({
    data: {
      userId: user.id,
      resumeId: crypto.randomUUID(),
      sourceHash: db.hash,
      details: { conflicts: [] },
    },
  });
  const authorization = {
    runId: crypto.randomUUID(),
    settingsHash: manifestHash(settings),
    resumeEvidenceId: resume.id,
    sourceHash: resume.sourceHash,
    snapshotHash: manifestHash({ settings, sourceHash: resume.sourceHash }),
  };
  campaign = await db.prisma.campaign.update({
    where: { campaignId: campaign.campaignId },
    data: {
      config: jsonValue({
        personal: { ...objectValue(objectValue(campaign.config).personal), authorization },
      }),
    },
  });
  async function record(
    identity: string = crypto.randomUUID(),
    url = `https://example.test/jobs/${identity}`,
  ) {
    const posting = {
      source: "greenhouse",
      boardToken: "synthetic",
      nativeId: identity,
      employer: "Synthetic Employer",
      title: "MBA internship",
      descriptionText:
        "This paid internship recruits MBA students. The internship runs from June 2027 to August 2027. You will work with our team and conduct research for our clients.",
      location: "New York, NY",
      url,
    };
    // A successful empty file-question inventory is distinct from an uninspected form.
    const questions = JSON.stringify({ id: identity, questions: [] });
    const questionHash = createHash("sha256").update(questions).digest("hex");
    const questionPath = join(db.root, "storage", user.id, `${questionHash}.json`);
    await writeFile(questionPath, questions, { mode: 0o600 });
    const attachmentRequirements = {
      schemaVersion: 1,
      identity: `greenhouse:synthetic:${identity}`,
      postingContentHash: manifestHash(posting),
      requirements: [],
      source: {
        kind: "greenhouse_questions",
        url: `https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/${identity}?questions=true`,
        path: questionPath,
        sha256: questionHash,
        capturedAt: new Date().toISOString(),
      },
    };
    const initial = await db.prisma.personalRecord.create({
      data: {
        userId: user.id,
        campaignId: campaign.campaignId,
        identity: `greenhouse:synthetic:${identity}`,
        requisitionId: identity,
        title: "Synthetic MBA internship",
        company: "Synthetic Employer",
        url,
        track: "mba_internship",
        state: "eligible",
        details: {
          posting,
          attachmentRequirements,
          attachments: [],
          eligibility: { decision: "eligible", reasons: [] },
          missingAnswers: [],
          documentVerification: {
            status: "passed",
            artifactSha256: db.hash,
            verifierVersion: "1",
            verifierConfigHash: documentPipelineInputs("cbs-letter-times").verifierConfigHash,
            renderer: "cbs-letter-times",
            pageCount: 1,
            extractedCharacters: 80,
            checks: [
              "artifact_hash",
              "page_limit",
              "text_layer",
              "glyphs",
              "renderer_margins",
              "layout_bounds",
            ].map((code) => ({ code, status: "passed", message: "Synthetic fixture only" })),
          },
          preview: {
            mode: "offline",
            readiness: "ready",
            conflicts: [],
            renderReviewed: true,
            pdfHash: db.hash,
          },
        },
      },
    });
    let record = await db.prisma.personalRecord.update({
      where: { id: initial.id },
      data: {
        details: jsonValue({
          ...objectValue(initial.details),
          eligibilityContext: eligibilityContext(initial, { settings, evidence: resume }),
        }),
      },
    });
    const verification = personalDocumentVerificationSchema.parse(
      objectValue(record.details).documentVerification,
    );
    const verificationBytes = JSON.stringify(verification, null, 2);
    const verificationHash = createHash("sha256").update(verificationBytes).digest("hex");
    const checksPath = join(db.root, "storage", user.id, "document-checks");
    await mkdir(checksPath, { recursive: true, mode: 0o700 });
    await writeFile(join(checksPath, `${verificationHash}.json`), verificationBytes, {
      mode: 0o600,
    });
    const input = {
      recordId: record.id,
      campaignId: campaign.campaignId,
      mode,
      leaseOwner: crypto.randomUUID(),
      manifest: {
        recordId: record.id,
        previewMode: mode,
        document: { path: artifactPath, sha256: db.hash },
        resumeEvidenceId: resume.id,
        sourceHash: db.hash,
        attachmentRequirements,
        attachments: [],
        readiness: { eligibility: "eligible", document: "ready", answers: "ready" },
      },
    };
    if (mode !== "offline") {
      const prepared = {
        ...input.manifest,
        answers: [],
        campaignRunId: authorization.runId,
        campaignSnapshotHash: authorization.snapshotHash,
      };
      const bytes = JSON.stringify(prepared, null, 2);
      const manifestPath = join(db.root, "storage", user.id, `${record.id}-manifest.json`);
      await writeFile(manifestPath, bytes, { mode: 0o600 });
      const details = objectValue(record.details);
      record = await db.prisma.personalRecord.update({
        where: { id: record.id },
        data: {
          details: jsonValue({
            ...details,
            document: {
              ...prepared.document,
              ...documentPipelineInputs("cbs-letter-times"),
              template: "cbs-letter-times",
            },
            manifestPath,
            preview: {
              ...objectValue(details.preview),
              manifestHash: createHash("sha256").update(bytes).digest("hex"),
            },
          }),
        },
      });
      Object.assign(input.manifest, prepared);
      if (!approve) return { record, input };
      const approvals = new PersonalApprovalService(db.prisma, db.service);
      const review = await approvals.get(user.id, record.id, "synthetic-session");
      if (!review.packet || review.blockers.length) throw new Error(review.blockers.join("; "));
      Object.assign(input.manifest, review.packet.preparedManifest);
      if (approve) {
        await approvals.approve(user.id, record.id, "synthetic-session", {
          expectedRecordVersion: review.recordVersion.toISOString(),
          packetHash: review.packetHash,
          nonce: review.nonce,
          confirm: true,
        });
        record = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
      }
    }
    return { record, input };
  }
  return { user, campaign, resume, record, artifactPath, settings };
}

export async function approvePersonalFixture(
  db: PersonalTestDatabase,
  userId: string,
  recordId: string,
  campaignId?: string,
) {
  if (campaignId) {
    const latest = await db.prisma.campaign.findFirst({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    await db.prisma.campaign.update({
      where: { campaignId },
      data: { updatedAt: new Date(Math.max(Date.now(), (latest?.updatedAt.getTime() ?? 0) + 1)) },
    });
  }
  const service = new PersonalApprovalService(db.prisma, db.service);
  const review = await service.get(userId, recordId, "synthetic-session");
  return service.approve(userId, recordId, "synthetic-session", {
    expectedRecordVersion: review.recordVersion.toISOString(),
    packetHash: review.packetHash,
    nonce: review.nonce,
    confirm: true,
  });
}

export async function refreshPersonalFixtureApproval(
  db: PersonalTestDatabase,
  userId: string,
  recordId: string,
  manifest: unknown,
  campaignId?: string,
) {
  const record = await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: recordId } });
  const details = objectValue(record.details);
  const bytes = JSON.stringify(manifest, null, 2);
  const manifestPath = join(db.root, "storage", userId, `${recordId}-refreshed.json`);
  await writeFile(manifestPath, bytes, { mode: 0o600 });
  await db.prisma.personalRecord.update({
    where: { id: recordId },
    data: {
      details: jsonValue({
        ...details,
        manifestPath,
        preview: {
          ...objectValue(details.preview),
          manifestHash: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
    },
  });
  return approvePersonalFixture(db, userId, recordId, campaignId);
}
