import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonalBrowserBroker,
  PlaywrightDriver,
} from "../../../../../plugin/scripts/personal-browser/core";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}
async function fixture(mutation: "clear" | "replace" | "none") {
  const root = await mkdtemp(join(tmpdir(), "multipart-browser-synthetic-"));
  const privateRoot = join(root, "storage", userId);
  await mkdir(privateRoot, { recursive: true });
  const resumePath = join(privateRoot, "resume.pdf"),
    coverPath = join(privateRoot, "cover.pdf");
  const resume = "%PDF synthetic resume",
    cover = "%PDF synthetic approved cover";
  await writeFile(resumePath, resume);
  await writeFile(coverPath, cover);
  const manifest = {
    canonicalUrl: "",
    identity: "greenhouse:synthetic:123",
    applicantEmail: "synthetic@example.test",
    document: { path: resumePath, sha256: hash(resume) },
    attachments: [
      {
        path: coverPath,
        sha256: hash(cover),
        fieldName: "cover_letter",
        label: "Cover",
        required: true,
      },
    ],
    answers: [{ key: "email", fieldName: "email", value: "synthetic@example.test" }],
  };
  const events: string[] = [];
  let state = "prepared";
  let receipt: { artifactPath: string; sha256: string; outcome: string } | undefined;
  const handler =
    mutation === "clear"
      ? "this.elements.cover_letter.value = '';"
      : mutation === "replace"
        ? "const transfer = new DataTransfer(); transfer.items.add(new File(['replacement not approved'], 'cover.pdf', {type:'application/pdf'})); this.elements.cover_letter.files = transfer.files;"
        : "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
        if (request.headers.get("authorization") !== "Bearer synthetic-token")
          return new Response(null, { status: 401 });
        if (path === `/api/personal/attempts/${attemptId}`)
          return Response.json({
            id: attemptId,
            userId,
            recordId,
            mode: "submit",
            state,
            manifest,
            manifestHash: hash(JSON.stringify(stable(manifest))),
            leaseOwner: "synthetic-owner",
            leaseGeneration: 1,
            leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
          });
        if (path === `/api/personal/${recordId}`)
          return Response.json({
            id: recordId,
            url: manifest.canonicalUrl,
            title: "Synthetic Analyst",
            identity: manifest.identity,
            requisitionId: "123",
          });
        if (path.endsWith("/authorize-transmission"))
          return Response.json({ status: "authorized" });
        if (path.endsWith("/begin-submit")) {
          events.push("begin-submit");
          state = "submitting";
          return Response.json({ state });
        }
        if (path.endsWith("/receipt")) {
          const body = (await request.json()) as { evidence: NonNullable<typeof receipt> };
          receipt = body.evidence;
          events.push("receipt");
          state = receipt.outcome === "submitted" ? "submitted" : "submission_uncertain";
          return Response.json({ state });
        }
        return new Response(null, { status: 404 });
      }
      if (path === "/jobs/123")
        return new Response(
          `<!doctype html><html><body><h1>Synthetic Analyst</h1><form action="/confirmation" method="post" enctype="multipart/form-data" onsubmit="${handler}"><label>Email<input type="email" name="email" required></label><label>Resume<input type="file" name="resume" required></label><label>Cover<input type="file" name="cover_letter" required></label><button type="submit">Submit application</button></form></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      if (path === "/confirmation" && request.method === "POST") {
        events.push("employer-post");
        return new Response(
          "<h1>Application submitted</h1><p>Synthetic Analyst</p><p>synthetic@example.test</p>",
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const api = `http://127.0.0.1:${server.port}`;
  manifest.canonicalUrl = `${api}/jobs/123`;
  const broker = new PersonalBrowserBroker(
    {
      api,
      token: "synthetic-token",
      attemptId,
      leaseOwner: "synthetic-owner",
      leaseGeneration: 1,
      root,
    },
    new PlaywrightDriver(),
  );
  async function prepare() {
    const snapshot = await broker.inspectForm();
    const email = snapshot.fields.find((field) => field.type === "email")!;
    const resumeField = snapshot.fields.find((field) => field.resumeUpload)!;
    const coverField = snapshot.fields.find((field) => field.attachmentKey === "attachment-0")!;
    await broker.fillField(email.ref, "answer-0");
    await broker.uploadResume(resumeField.ref);
    await broker.uploadAttachment(coverField.ref, "attachment-0");
  }
  return {
    broker,
    prepare,
    events,
    state: () => state,
    receipt: () => receipt,
    async close() {
      try {
        await broker.close();
      } finally {
        await server.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

describe("real browser final multipart attachment guard", () => {
  for (const mutation of ["clear", "replace"] as const)
    test(`blocks an inline submit handler that ${mutation}s a frozen file`, async () => {
      const f = await fixture(mutation);
      try {
        await f.prepare();
        const result = await f.broker.submitApplication();
        expect(result.status).toBe("submission_uncertain");
        expect(f.state()).toBe("submission_uncertain");
        expect(f.events.filter((event) => event === "begin-submit")).toHaveLength(1);
        expect(f.events.filter((event) => event === "employer-post")).toHaveLength(0);
        const receipt = f.receipt()!;
        expect(receipt.outcome).toBe("uncertain");
        expect(hash(await readFile(receipt.artifactPath, "utf8"))).toBe(receipt.sha256);
        await expect(f.broker.submitApplication()).rejects.toThrow("cannot be retried");
        expect(f.events.filter((event) => event === "begin-submit")).toHaveLength(1);
        expect(f.events.filter((event) => event === "employer-post")).toHaveLength(0);
      } finally {
        await f.close();
      }
    }, 30000);
  test("allows exactly one unchanged approved native multipart submission", async () => {
    const f = await fixture("none");
    try {
      await f.prepare();
      expect((await f.broker.submitApplication()).status).toBe("submitted");
      expect(f.events.filter((event) => event === "employer-post")).toHaveLength(1);
      expect(f.events.indexOf("begin-submit")).toBeLessThan(f.events.indexOf("employer-post"));
    } finally {
      await f.close();
    }
  }, 30000);
});
