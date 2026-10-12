import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserDriver,
  PersonalBrowserBroker,
  PlaywrightDriver,
} from "../../../../../plugin/scripts/personal-browser/core";
import { describe, expect, test } from "bun:test";

const id = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
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
async function fixture(
  mode: "offline" | "live_preview" | "submit",
  driver: BrowserDriver = new PlaywrightDriver(),
  failClick = false,
  options: {
    confirmationHtml?: string;
    duplicatePost?: boolean;
    urlQuery?: string;
    redirect?: boolean;
    checkbox?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "broker-fixture-"));
  const path = join(root, "resume.pdf");
  await writeFile(path, "%PDF-synthetic-fixture", { mode: 0o600 });
  const events: string[] = [];
  let state = "preparing";
  let receipt: unknown;
  let url = "";
  const manifest = {
    answers: [
      { key: "email", fieldName: "email", value: "synthetic@example.test" },
      ...(options.checkbox ? [{ key: "confirmed", fieldName: "confirmed", value: true }] : []),
    ],
    document: { path, sha256: hash("%PDF-synthetic-fixture") },
    applicantEmail: "synthetic@example.test",
    canonicalUrl: "",
    identity: "greenhouse:fixture:123",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const requestUrl = new URL(request.url);
      const route = requestUrl.pathname;
      if (route.startsWith("/api/")) {
        events.push(`${request.method} ${route}`);
        if (route === `/api/personal/attempts/${id}`)
          return Response.json({
            id,
            userId,
            recordId,
            mode,
            state,
            manifest,
            manifestHash: hash(JSON.stringify(stable(manifest))),
            leaseOwner: "fixture-owner",
            leaseGeneration: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        if (route === `/api/personal/${recordId}`)
          return Response.json({
            id: recordId,
            title: "Synthetic Analyst",
            url,
            identity: manifest.identity,
            requisitionId: "123",
          });
        if (route.endsWith("/prepare")) {
          state = "prepared";
          return Response.json({ state });
        }
        if (route.endsWith("/authorize-transmission"))
          return Response.json({ status: "authorized" });
        if (route.endsWith("/begin-submit")) {
          state = "submitting";
          return Response.json({ state });
        }
        if (route.endsWith("/receipt")) {
          const body = (await request.json()) as { evidence: { outcome: string } };
          receipt = body.evidence;
          state = body.evidence.outcome === "submitted" ? "submitted" : "submission_uncertain";
          return Response.json({ state });
        }
        return new Response("Unknown API", { status: 404 });
      }
      events.push(`${request.method} ${route}`);
      if (route === "/jobs/123" && options.redirect)
        return new Response(null, {
          status: 302,
          headers: { location: "/outside?contact_token=synthetic-secret" },
        });
      if (route === "/jobs/123")
        return new Response(
          `<!doctype html><html><body><h1>Synthetic Analyst</h1><form action="/confirmation" method="post" enctype="multipart/form-data"><label>Email <input type="email" name="email" required></label><label>Resume <input type="file" name="resume" required></label>${options.checkbox ? '<label>Synthetic confirmation<input type="checkbox" name="confirmed" required></label>' : ""}<button type="submit">Submit application</button></form></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      if (route === "/confirmation") {
        if (failClick) return new Response("Unexpected error", { status: 500 });
        return new Response(
          options.confirmationHtml ??
            `<h1>Application submitted</h1><p>Synthetic Analyst</p><p>synthetic@example.test</p>${options.duplicatePost ? "<script>fetch('/confirmation',{method:'POST'})</script>" : ""}`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("", { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}/jobs/123${options.urlQuery ?? ""}`;
  manifest.canonicalUrl = url;
  const broker = new PersonalBrowserBroker(
    {
      api: `http://127.0.0.1:${server.port}`,
      token: "synthetic-token",
      attemptId: id,
      leaseOwner: "fixture-owner",
      leaseGeneration: 1,
      root,
    },
    driver,
  );
  return {
    broker,
    events,
    path,
    manifest,
    state: () => state,
    setState: (next: string) => {
      state = next;
    },
    receipt: () => receipt,
    async close() {
      try {
        await broker.close();
      } finally {
        try {
          await server.stop(true);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  };
}
const neverBrowser: BrowserDriver = {
  open: async () => {
    throw new Error("Browser must never launch");
  },
  snapshot: async () => {
    throw new Error("No page");
  },
  fill: async () => {},
  upload: async () => {},
  submit: async () => {
    throw new Error("No submit");
  },
  close: async () => {},
};
async function prepare(broker: PersonalBrowserBroker) {
  const snapshot = await broker.inspectForm();
  const email = snapshot.fields.find((field) => field.type === "email");
  const resume = snapshot.fields.find((field) => field.resumeUpload);
  if (!email || !resume) throw new Error("Fixture fields missing");
  await broker.fillField(email.ref, "answer-0");
  await broker.uploadResume(resume.ref);
}
describe("scoped personal browser broker", () => {
  test("offline inspection never launches a browser or reaches employer endpoints", async () => {
    const f = await fixture("offline", neverBrowser);
    try {
      await expect(f.broker.inspectForm()).rejects.toThrow("offline");
      expect(f.events.every((event) => event.includes("/api/"))).toBe(true);
    } finally {
      await f.close();
    }
  });
  test("live preview refuses submission and arbitrary answer payloads", async () => {
    const f = await fixture("live_preview");
    try {
      await prepare(f.broker);
      await expect(f.broker.submitApplication()).rejects.toThrow("prohibited");
      await expect(
        f.broker.call("fill_field", { ref: "x", answerKey: "email", value: "invented" }),
      ).rejects.toThrow("unauthorized");
      expect(f.events.some((event) => event.includes("begin-submit"))).toBe(false);
      expect(f.events).not.toContain("POST /confirmation");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("hash mismatch prevents resume upload", async () => {
    const f = await fixture("live_preview");
    try {
      const snapshot = await f.broker.inspectForm();
      await writeFile(f.path, "tampered");
      await expect(
        f.broker.uploadResume(snapshot.fields.find((field) => field.resumeUpload)?.ref ?? ""),
      ).rejects.toThrow("hash mismatch");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("API final permit precedes the one actual submit and hashed receipt", async () => {
    const f = await fixture("submit");
    try {
      await prepare(f.broker);
      const result = await f.broker.submitApplication();
      expect(result.status).toBe("submitted");
      expect(f.events.findIndex((event) => event.includes("begin-submit"))).toBeLessThan(
        f.events.indexOf("POST /confirmation"),
      );
      expect(f.state()).toBe("submitted");
      const receipt = f.receipt() as { artifactPath: string; sha256: string };
      expect(hash(await readFile(receipt.artifactPath, "utf8"))).toBe(receipt.sha256);
      expect(receipt.artifactPath).toContain(`/storage/${userId}/receipts/`);
      expect(result).not.toHaveProperty("evidence");
      expect(JSON.stringify(result)).not.toContain("synthetic@example.test");
      await expect(f.broker.submitApplication()).rejects.toThrow("cannot be retried");
      expect(f.events.filter((event) => event === "POST /confirmation")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30_000);
  test("missing confirmation after final click becomes uncertain with no retry", async () => {
    const f = await fixture("submit", new PlaywrightDriver(), true);
    try {
      await prepare(f.broker);
      expect((await f.broker.submitApplication()).status).toBe("submission_uncertain");
      expect(f.state()).toBe("submission_uncertain");
      await expect(f.broker.submitApplication()).rejects.toThrow("cannot be retried");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("browser crash after API boundary leaves uncertainty and no second click", async () => {
    class CrashDriver extends PlaywrightDriver {
      override async submit() {
        throw new Error("Synthetic browser crash");
      }
    }
    const f = await fixture("submit", new CrashDriver());
    try {
      await prepare(f.broker);
      expect((await f.broker.submitApplication()).status).toBe("submission_uncertain");
      expect(f.state()).toBe("submission_uncertain");
      expect(f.events.some((event) => event.includes("begin-submit"))).toBe(true);
      expect(f.events).not.toContain("POST /confirmation");
      await expect(f.broker.submitApplication()).rejects.toThrow("cannot be retried");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("cancelled attempt loses fill and upload authority immediately", async () => {
    const f = await fixture("live_preview");
    try {
      const snapshot = await f.broker.inspectForm();
      f.setState("cancelled");
      await expect(
        f.broker.fillField(
          snapshot.fields.find((field) => field.type === "email")?.ref ?? "",
          "answer-0",
        ),
      ).rejects.toThrow("cancelled");
      await expect(
        f.broker.uploadResume(snapshot.fields.find((field) => field.resumeUpload)?.ref ?? ""),
      ).rejects.toThrow("cancelled");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("quoted confirmation instructions do not establish a receipt", async () => {
    const f = await fixture("submit", new PlaywrightDriver(), false, {
      confirmationHtml:
        "<h1>Read this example</h1><blockquote><h1>Application submitted</h1><p>Synthetic Analyst synthetic@example.test</p></blockquote>",
    });
    try {
      await prepare(f.broker);
      expect((await f.broker.submitApplication()).status).toBe("submission_uncertain");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("a final permit allows exactly one matching POST", async () => {
    const f = await fixture("submit", new PlaywrightDriver(), false, { duplicatePost: true });
    try {
      await prepare(f.broker);
      expect((await f.broker.submitApplication()).status).toBe("submitted");
      expect(f.events.filter((event) => event === "POST /confirmation")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30_000);
  test("inspection output redacts contact tokens from captured URLs", async () => {
    const f = await fixture("live_preview", new PlaywrightDriver(), false, {
      urlQuery: "?contact_token=synthetic-secret",
    });
    try {
      const snapshot = await f.broker.inspectForm();
      expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret");
      expect(snapshot).not.toHaveProperty("url");
    } finally {
      await f.close();
    }
  }, 30_000);
  test("redirect destinations are not fetched or leaked", async () => {
    const f = await fixture("live_preview", new PlaywrightDriver(), false, { redirect: true });
    try {
      // Await browser startup outside Bun's rejection matcher so subprocess I/O stays live.
      let failure: unknown;
      try {
        await f.broker.inspectForm();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Navigation left the authorized source origin");
      expect(f.events).toContain("GET /jobs/123");
      expect(f.events.some((event) => event.includes("/outside"))).toBe(false);
    } finally {
      await f.close();
    }
  }, 30_000);
});

test("metadata-only broker never exposes applicant values, labels, raw pages or receipts", async () => {
  const secret = "PRIVATE_MEDICAL_CANARY_8429";
  class PrivatePageDriver extends PlaywrightDriver {
    override async snapshot() {
      const snapshot = await super.snapshot();
      return {
        ...snapshot,
        text: `${snapshot.text}\n${secret}`,
        fields: snapshot.fields.map((field) => ({
          ...field,
          label: `${field.label} ${secret}`,
          options: [secret],
        })),
      };
    }
  }
  const f = await fixture("submit", new PrivatePageDriver());
  try {
    const inspection = await f.broker.inspectForm();
    expect(JSON.stringify(inspection)).not.toContain(secret);
    expect(JSON.stringify(inspection)).not.toContain("synthetic@example.test");
    expect(inspection).not.toHaveProperty("text");
    expect(inspection).not.toHaveProperty("answers");
    const email = inspection.fields.find((field) => field.type === "email");
    const resume = inspection.fields.find((field) => field.resumeUpload);
    if (!email?.answerKey || !resume) throw new Error("Expected opaque mappings");
    expect(JSON.stringify(await f.broker.fillField(email.ref, email.answerKey))).not.toContain(
      secret,
    );
    await f.broker.uploadResume(resume.ref);
    const result = await f.broker.submitApplication();
    expect(result.status).toBe("submitted");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("artifactPath");
    const receipt = f.receipt() as { artifactPath: string };
    expect(await readFile(receipt.artifactPath, "utf8")).toContain(secret);
  } finally {
    await f.close();
  }
}, 30_000);

test("explicit true checkbox answers pass through the broker without coercion", async () => {
  const f = await fixture("submit", new PlaywrightDriver(), false, { checkbox: true });
  try {
    const form = await f.broker.inspectForm();
    const email = form.fields.find((field) => field.type === "email");
    const resume = form.fields.find((field) => field.resumeUpload);
    const checkbox = form.fields.find((field) => field.type === "checkbox");
    if (!email?.answerKey || !resume || !checkbox?.answerKey)
      throw new Error("Missing synthetic fields");
    await f.broker.fillField(email.ref, email.answerKey);
    await f.broker.fillField(checkbox.ref, checkbox.answerKey);
    await f.broker.uploadResume(resume.ref);
    expect((await f.broker.submitApplication()).status).toBe("submitted");
  } finally {
    await f.close();
  }
}, 30_000);
