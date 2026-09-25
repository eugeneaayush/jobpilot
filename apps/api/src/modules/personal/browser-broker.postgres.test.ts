import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { personalAttemptReceiptSchema } from "@jobpilot/contracts/personal-attempt";
import type { PersonalScreeningAnswer } from "@jobpilot/contracts/personal-readiness";
import { PersonalBrowserBroker } from "../../../../../plugin/scripts/personal-browser/core";
import { manifestHash } from "./persistence-policy";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const connection = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!connection)("broker with actual PostgreSQL receipt lifecycle", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(connection!);
  }, 30_000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  test("synthetic final action persists a verified receipt and restart prevents another submit", async () => {
    const f = await personalFixture(db);
    let recordId = "";
    let attemptId = "";
    let posts = 0;
    const received: { resumeHash: string | null; email: string | null } = {
      resumeHash: null,
      email: null,
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname;
        if (route === "/jobs/123")
          return new Response(
            '<h1>Synthetic MBA internship</h1><form action="/done" method="POST" enctype="multipart/form-data"><label>Email<input name="email" type="email" required></label><label>Resume<input name="resume" type="file" required></label><button type="submit">Submit application</button></form>',
            { headers: { "content-type": "text/html" } },
          );
        if (route === "/done") {
          const form = await request.formData();
          const resume = form.get("resume");
          if (!(resume instanceof File))
            return new Response("Missing resume file", { status: 400 });
          received.resumeHash = sha256(new Uint8Array(await resume.arrayBuffer()));
          received.email = String(form.get("email"));
          posts++;
          return new Response(
            "<h1>Application submitted</h1><p>Synthetic MBA internship synthetic@example.test</p>",
            { headers: { "content-type": "text/html" } },
          );
        }
        if (request.headers.get("authorization") !== "Bearer synthetic-token")
          return new Response(null, { status: 401 });
        try {
          if (route === `/api/personal/${recordId}`)
            return Response.json(
              await db.prisma.personalRecord.findUniqueOrThrow({ where: { id: recordId } }),
            );
          if (route === `/api/personal/attempts/${attemptId}`)
            return Response.json(await db.service.get(f.user.id, attemptId));
          const body = await request.json();
          const lease = { leaseOwner: "synthetic-broker", leaseGeneration: 1 };
          if (route.endsWith("/prepare"))
            return Response.json(await db.service.prepare(f.user.id, attemptId, lease));
          if (route.endsWith("/begin-submit"))
            return Response.json(await db.service.beginSubmit(f.user.id, attemptId, lease));
          if (route.endsWith("/receipt")) {
            const parsed = personalAttemptReceiptSchema.parse(body);
            return Response.json(
              await db.service.receipt(f.user.id, attemptId, parsed, parsed.evidence),
            );
          }
        } catch {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 404 });
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const r = await f.record(crypto.randomUUID(), `${url}/jobs/123`);
    recordId = r.record.id;
    const questions = JSON.stringify({
      id: r.record.requisitionId,
      questions: [
        { label: "Email", required: true, fields: [{ name: "email", type: "input_email" }] },
        { label: "Resume", required: true, fields: [{ name: "resume", type: "input_file" }] },
      ],
    });
    const questionHash = sha256(questions);
    const questionPath = join(db.root, "storage", f.user.id, `${questionHash}.json`);
    await writeFile(questionPath, questions, { mode: 0o600 });
    const attachmentRequirements = {
      ...r.input.manifest.attachmentRequirements,
      requirements: [{ fieldName: "resume", label: "Resume", required: true, kind: "resume" }],
      source: {
        ...r.input.manifest.attachmentRequirements.source,
        path: questionPath,
        sha256: questionHash,
      },
    };
    const sourcedAnswers: PersonalScreeningAnswer[] = [
      {
        key: "email",
        fieldName: "email",
        value: "synthetic@example.test",
        source: { kind: "explicit_user", confirmed: true },
      },
    ];
    const snapshotContent = {
      schemaVersion: 1,
      recordId,
      identity: r.record.identity,
      postingContentHash: attachmentRequirements.postingContentHash,
      settingsHash: manifestHash(f.settings),
      createdAt: new Date().toISOString(),
      answers: sourcedAnswers,
    };
    const snapshot = { ...snapshotContent, snapshotHash: manifestHash(snapshotContent) };
    await db.prisma.personalRecord.update({
      where: { id: recordId },
      data: {
        details: jsonValue({
          ...objectValue(r.record.details),
          attachmentRequirements,
          previewAttachments: { attachmentRequirements, attachments: [] },
          screeningAnswers: snapshot,
        }),
      },
    });
    const input = {
      ...r.input,
      leaseOwner: "synthetic-broker",
      manifest: {
        ...r.input.manifest,
        identity: r.record.identity,
        canonicalUrl: r.record.url,
        postingContentHash: attachmentRequirements.postingContentHash,
        attachmentRequirements,
        screeningAnswerSnapshot: snapshot,
        screeningAnswerSnapshotHash: snapshot.snapshotHash,
        answers: [{ key: "email", fieldName: "email", value: "synthetic@example.test" }],
      },
    };
    const attempt = await db.service.start(f.user.id, input);
    attemptId = attempt.id;
    const config = {
      api: url,
      token: "synthetic-token",
      attemptId,
      leaseOwner: attempt.leaseOwner,
      leaseGeneration: attempt.leaseGeneration,
      root: db.root,
    };
    const broker = new PersonalBrowserBroker(config);
    try {
      const form = await broker.inspectForm();
      const email = form.fields.find((field) => field.type === "email");
      const resume = form.fields.find((field) => field.resumeUpload);
      if (!email?.answerKey || !resume) throw new Error("Synthetic mapping missing");
      await broker.fillField(email.ref, email.answerKey);
      await broker.uploadResume(resume.ref);
      expect((await broker.submitApplication()).status).toBe("submitted");
      const persisted = await db.service.get(f.user.id, attemptId);
      expect(persisted.state).toBe("submitted");
      expect(posts).toBe(1);
      expect(received.resumeHash).toBe(db.hash);
      expect(received.email).toBe("synthetic@example.test");
      await broker.close();
      const restarted = new PersonalBrowserBroker(config);
      try {
        await expect(restarted.submitApplication()).rejects.toThrow();
      } finally {
        await restarted.close();
      }
      await expect(db.service.start(f.user.id, input)).rejects.toThrow("existing or unresolved");
      expect(posts).toBe(1);
    } finally {
      await broker.close();
      await server.stop(true);
    }
  }, 30_000);
});
