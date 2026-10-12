import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import {
  personalApprovalInputSchema,
  personalApprovalResponseSchema,
} from "@jobpilot/contracts/personal-approval";
import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth";
import { env } from "@/env";
import { PersonalBrowserBroker } from "../../../../../plugin/scripts/personal-browser/core";
import { personalApprovalGuard } from "./approval.guard";
import { PersonalApprovalService } from "./approval.service";
import { PersonalAttachmentsService } from "./attachments.service";
import { PersonalCampaignService } from "./campaign.service";
import { PersonalDiscoveryService } from "./discovery.service";
import { localToolsPython } from "./local-tools/runner";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import type { PersonalService } from "./personal.service";
import { PersonalPreparationService } from "./preparation.service";
import { PersonalPreviewService } from "./preview.service";
import { PersonalReadinessService } from "./readiness.service";
import { objectValue } from "./runtime";
import type { runCodexClaimReview, runCodexRenderReview } from "./tailoring/codex-review";
import { sourceFixture, supportedReview } from "./tailoring/fakes";
import type { TailoringInput } from "./tailoring/proposal";
import { PersonalTailoringService } from "./tailoring.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// Only the model calls are synthetic; discovery normalization, facts, storage, PDFs and browser use real services.
class FixtureTailoring extends PersonalTailoringService {
  protected override async generate(input: TailoringInput) {
    const fact = input.facts.find((item) => item.editable)!;
    return {
      status: "proposed" as const,
      proposal: {
        version: 1 as const,
        inputHash: input.inputHash,
        rewrites: [
          {
            id: "rewrite-1",
            targetFactId: fact.id,
            text: "Developed SQL reporting for a $12M portfolio",
            citations: [{ factId: fact.id, quoteSha256: fact.quoteSha256 }],
          },
        ],
        essayClaims: [],
      },
      artifactPath: "/synthetic/model-proposal.json",
      providerMode: "chatgpt_subscription" as const,
    };
  }
}
class FixturePreparation extends PersonalPreparationService {
  protected override claimReview: typeof runCodexClaimReview = async (input, proposed) => ({
    status: "reviewed",
    review: supportedReview(input, proposed),
    artifactPath: "/synthetic/independent-claim-review.json",
    providerMode: "chatgpt_subscription",
  });
  protected override renderReview: typeof runCodexRenderReview = async (input) => ({
    status: "reviewed",
    artifactPath: "/synthetic/independent-visual-review.json",
    providerMode: "chatgpt_subscription",
    review: {
      pdfHash: input.pdfHash,
      maxPages: input.maxPages,
      decision: "pass",
      reviewer: "independent-synthetic-visual-reviewer",
      reviewedAt: new Date().toISOString(),
      pages: input.pages.map((page) => ({
        pageNumber: page.pageNumber,
        imageHash: page.sha256,
        decision: "pass",
        findings: ["Synthetic reviewer fixture; image rendering and deterministic checks are real"],
      })),
    },
  });
}

const connection = process.env.PERSONAL_TEST_DATABASE_URL;
const toolsAvailable =
  (await Bun.file(localToolsPython()).exists()) &&
  Boolean(Bun.which("pdftotext")) &&
  Boolean(Bun.which("pdftoppm"));
describe.skipIf(!connection || !toolsAvailable)("integrated private synthetic campaign", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(connection!);
  }, 30_000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  test("discovers a low-fit eligible posting, reviews exact real documents, grants cookie approval and verifies fills without submitting", async () => {
    const f = await personalFixture(db, "offline");
    const data = sourceFixture().data;
    const settings = personalSettingsSchema.parse({
      ...f.settings,
      mbaEnrolled: true,
      graduationYear: 2028,
      requiresSponsorship: false,
      targetFunctions: ["Quantum physics"],
    });
    await writeFile(join(db.root, "settings", `${f.user.id}.json`), JSON.stringify(settings), {
      mode: 0o600,
    });
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({
        account: { userId: f.user.id },
        tailoringProvider: { provider: "openai", allowApplicantData: true },
      }),
      { mode: 0o600 },
    );
    const saved = (id: string) => db.prisma.personalRecord.findUniqueOrThrow({ where: { id } });
    const personal = {
      settings: async () => settings,
      resumeData: async () => ({ data, evidence: f.resume, resume: { id: f.resume.resumeId } }),
      record: async (_user: string, id: string) => saved(id),
      pdf: async (_user: string, id: string) =>
        new Response(
          await readFile(String(objectValue(objectValue((await saved(id)).details).document).path)),
        ),
    } as unknown as PersonalService;
    const campaigns = new PersonalCampaignService(db.prisma, personal, db.service);
    const created = await campaigns.create(f.user.id, {
      name: "Synthetic complete integration",
      mode: "submit",
      sources: { boardTokens: ["synthetic"] },
      tracks: ["mba_internship"],
      fitThreshold: 100,
      dailyCap: 3,
      maxApplications: 10,
      timezone: "America/New_York",
    });
    const campaign = await campaigns.launch(f.user.id, created.id, true);
    let recordId = "";
    let attemptId = "";
    let finalPosts = 0;
    let lease = { leaseOwner: "synthetic-integrated-broker", leaseGeneration: 1 };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname;
        if (route === "/jobs/123")
          return new Response(
            '<h1>Synthetic MBA internship</h1><form action="/done" method="POST"><label>Email<input type="email" name="email" required></label><label>Resume<input type="file" name="resume" required></label><button type="submit">Submit application</button></form>',
            { headers: { "content-type": "text/html" } },
          );
        if (route === "/done") {
          finalPosts++;
          return new Response("Unexpected final submission", { status: 400 });
        }
        if (request.headers.get("authorization") !== "Bearer synthetic-token")
          return new Response(null, { status: 401 });
        try {
          if (route === `/api/personal/${recordId}`) return Response.json(await saved(recordId));
          if (route === `/api/personal/attempts/${attemptId}`)
            return Response.json(await db.service.get(f.user.id, attemptId));
          if (route.endsWith("/authorize-transmission"))
            return Response.json(
              await db.service.authorizeTransmission(f.user.id, attemptId, lease),
            );
          if (route.endsWith("/prepare"))
            return Response.json(await db.service.prepare(f.user.id, attemptId, lease));
        } catch {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 404 });
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const originalFetch = globalThis.fetch;
    const originalOrigin = env.CORS_ORIGINS;
    let broker: PersonalBrowserBroker | undefined;
    try {
      const sourceUrl = "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs?content=true";
      const questionUrl =
        "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/123?questions=true";
      const requests: string[] = [];
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const target = input instanceof Request ? input.url : String(input);
        requests.push(target);
        if (target === sourceUrl)
          return Response.json({
            meta: { total: 1 },
            jobs: [
              {
                id: 123,
                internal_job_id: 123,
                title: "MBA internship",
                company_name: "Synthetic Employer",
                absolute_url: `${url}/jobs/123`,
                location: { name: "New York, NY" },
                content:
                  "<p>This paid internship recruits MBA students graduating in 2028. The internship runs from June 2027 to August 2027. You will work with our team and conduct research for our clients. English is sufficient. Applicants must be authorized to work in the US.</p>",
              },
            ],
          });
        if (target === questionUrl)
          return Response.json({
            id: 123,
            questions: [
              { label: "Email", required: true, fields: [{ name: "email", type: "input_email" }] },
              { label: "Resume", required: true, fields: [{ name: "resume", type: "input_file" }] },
            ],
          });
        throw new Error(`Unexpected external request: ${target}`);
      }) as typeof fetch;
      const discovery = await new PersonalDiscoveryService(db.prisma, personal).discover(
        f.user.id,
        { source: "greenhouse", boardToken: "synthetic", employer: "Synthetic Employer" },
      );
      expect(discovery.status).toBe("complete");
      const row = await db.prisma.personalRecord.findUniqueOrThrow({
        where: { userId_identity: { userId: f.user.id, identity: "greenhouse:synthetic:123" } },
      });
      recordId = row.id;
      expect(objectValue(objectValue(row.details).eligibility).decision).toBe("eligible");
      expect(Number(objectValue(row.details).fitScore)).toBeLessThan(100);
      await new PersonalAttachmentsService(db.prisma, personal).refresh(f.user.id, recordId);
      expect(requests).toEqual([sourceUrl, questionUrl]);
      globalThis.fetch = originalFetch;
      const current = await saved(recordId);
      await new PersonalReadinessService(db.prisma).saveAnswers(f.user.id, recordId, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
        answers: [
          {
            key: "email",
            fieldName: "email",
            value: data.basics.email!,
            source: { kind: "explicit_user", confirmed: true },
          },
        ],
      });
      const preview = new PersonalPreviewService(db.prisma, personal);
      const preparation = new FixturePreparation(
        db.prisma,
        personal,
        new FixtureTailoring(db.prisma, personal),
        preview,
      );
      for (let i = 0; i < 4; i++) {
        const result = await preparation.advance(f.user.id, recordId, campaign.id);
        expect(result.status).toBe(i === 3 ? "ready" : "pending");
      }
      const details = objectValue((await saved(recordId)).details);
      expect(objectValue(details.documentVerification).status).toBe("passed");
      expect(objectValue(details.preview).renderReviewed).toBe(true);
      const pdf = await readFile(String(objectValue(details.document).path));
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const beforeApproval = await campaigns.next(f.user.id, campaign.id, lease.leaseOwner);
      expect(beforeApproval.status).toBe("idle");
      expect(await db.prisma.personalAttempt.count({ where: { recordId } })).toBe(0);
      const approvals = new PersonalApprovalService(db.prisma, db.service);
      env.CORS_ORIGINS = "http://localhost:4100";
      const token = await signAccessToken({ id: f.user.id, email: f.user.email, role: "USER" });
      const app = new Elysia()
        .use(personalApprovalGuard)
        .get("/review", ({ user, approvalSession }) =>
          approvals.get(user.id, recordId, approvalSession),
        )
        .post("/approve", ({ user, approvalSession, body }) =>
          approvals.approve(
            user.id,
            recordId,
            approvalSession,
            personalApprovalInputSchema.parse(body),
          ),
        );
      const headers = {
        origin: env.CORS_ORIGINS,
        cookie: `accessToken=${token}`,
        "content-type": "application/json",
      };
      const rawPacket = await (
        await app.handle(new Request("http://localhost/review", { headers }))
      ).json();
      const packet = personalApprovalResponseSchema.parse({
        ...rawPacket,
        recordVersion: new Date(rawPacket.recordVersion),
      });
      expect(packet.blockers).toEqual([]);
      const approved = await app.handle(
        new Request("http://localhost/approve", {
          method: "POST",
          headers,
          body: JSON.stringify({
            expectedRecordVersion: packet.recordVersion.toISOString(),
            packetHash: packet.packetHash,
            nonce: packet.nonce,
            confirm: true,
          }),
        }),
      );
      expect(approved.status).toBe(200);
      const next = await campaigns.next(f.user.id, campaign.id, lease.leaseOwner);
      expect(next.status).toBe("task");
      if (next.status !== "task") throw new Error(JSON.stringify(next));
      attemptId = next.attempt.id;
      lease = {
        leaseOwner: next.attempt.leaseOwner,
        leaseGeneration: next.attempt.leaseGeneration,
      };
      broker = new PersonalBrowserBroker({
        api: url,
        token: "synthetic-token",
        attemptId,
        ...lease,
        root: db.root,
      });
      const form = await broker.inspectForm();
      const email = form.fields.find((field) => field.type === "email");
      const resume = form.fields.find((field) => field.resumeUpload);
      if (!email?.answerKey || !resume)
        throw new Error("Synthetic form did not map to exact approved packet");
      expect((await broker.fillField(email.ref, email.answerKey)).status).toBe("filled");
      expect((await broker.uploadResume(resume.ref)).status).toBe("uploaded");
      expect(finalPosts).toBe(0);
      expect((await db.service.get(f.user.id, attemptId)).state).toBe("prepared");
      expect(await db.prisma.personalReservation.count({ where: { attemptId } })).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      env.CORS_ORIGINS = originalOrigin;
      await broker?.close();
      await server.stop(true);
    }
  }, 60_000);
});
