import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { env } from "@/env";
import { PrismaClient } from "@/generated/prisma/client";
import { PersonalAttemptService } from "./attempt.service";
import { eligibilityContext } from "./eligibility-freshness";
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
  const campaign = await db.prisma.campaign.create({
    data: {
      userId: user.id,
      query: "Synthetic test",
      source: "apply",
      config: {
        personal: {
          enabled: true,
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
    const record = await db.prisma.personalRecord.update({
      where: { id: initial.id },
      data: {
        details: jsonValue({
          ...objectValue(initial.details),
          eligibilityContext: eligibilityContext(initial, { settings, evidence: resume }),
        }),
      },
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
    return { record, input };
  }
  return { user, campaign, resume, record, artifactPath, settings };
}
