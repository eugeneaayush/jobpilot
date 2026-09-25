import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { PersonalBrowserBroker } from "../../../../../plugin/scripts/personal-browser/core";
import { GreenhouseDriver } from "../../../../../plugin/scripts/personal-browser/greenhouse-driver";
import { manifestHash } from "./persistence-policy";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const posting = "https://job-boards.greenhouse.io/fixture/jobs/123";
const identity = "greenhouse:fixture:123";
const controls = {
  login: '<label>Password<input type="password"></label>',
  otp: '<label>Security code<input autocomplete="one-time-code"></label>',
  captcha:
    '<p>Verify you are human</p><iframe title="CAPTCHA" src="https://www.recaptcha.net/recaptcha/enterprise/bframe" width="300" height="120"></iframe>',
};
const loader = {
  urlToken: "fixture",
  jobPostId: "123",
  submitPath: "https://boards.greenhouse.io/fixture/jobs/123",
  confirmationPath: "/fixture/jobs/123/confirmation",
  jobPost: {
    id: 123,
    title: "Synthetic Analyst",
    public_url: posting,
    post_type: "job_post",
    fingerprint: "synthetic-fingerprint",
    questions: [],
  },
};
function htmlDocument(body: string) {
  return `<!doctype html><html><body>${body}</body></html>`;
}
async function failureFrom(work: Promise<unknown>): Promise<Error> {
  // Bun's async rejection matcher can starve Playwright's launch pipe on macOS.
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the synthetic operation to fail");
}
function application(extra = "", route = loader) {
  return htmlDocument(`<h1>Synthetic Analyst</h1>${extra}
    <form id="application-form" class="application--form">
    <label for="first_name">First name</label><input id="first_name">
    <label for="last_name">Last name</label><input id="last_name">
    <label for="email">Email</label><input id="email" type="email">
    <button type="submit">Submit application</button></form>
    <script>window.__remixContext={state:{loaderData:{'routes/$url_token_.jobs_.$job_post_id':${JSON.stringify(route)}}}};</script>`);
}
async function fixture(html: string, status = 200) {
  const root = await mkdtemp(join(tmpdir(), "greenhouse-security-synthetic-"));
  const requests: { url: string; method: string }[] = [];
  const driver = new GreenhouseDriver({
    transport: async (request) => {
      requests.push({ url: request.url, method: request.method });
      if (request.url === posting) {
        if (status === 302) {
          const { context } = driver as unknown as { context: BrowserContext };
          await context.setOffline(true);
          return new Response(null, {
            status,
            headers: { location: "https://outside.invalid/login" },
          });
        }
        return new Response(html, { status, headers: { "content-type": "text/html" } });
      }
      if (request.url.startsWith("https://www.recaptcha.net/recaptcha/enterprise/bframe"))
        return new Response(htmlDocument("Synthetic challenge frame"), {
          headers: { "content-type": "text/html" },
        });
      throw new Error("Unrecognized synthetic request");
    },
  });
  driver.configure({
    attemptId,
    manifestHash: createHash("sha256").update("synthetic").digest("hex"),
    identity,
    authorize: async () => {},
    freeze: async () => {
      throw new Error("Security fixtures must never submit");
    },
  });
  return {
    root,
    driver,
    requests,
    page: () => (driver as unknown as { page: Page }).page,
    async close() {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Greenhouse security shell classification", () => {
  for (const [kind, control] of Object.entries(controls)) {
    test(`visible ${kind} without an application form creates one broker handoff`, async () => {
      const f = await fixture(htmlDocument(control), kind === "otp" ? 403 : 200);
      const apiCalls: string[] = [];
      const handoffs: unknown[] = [];
      const manifest = { canonicalUrl: posting, identity, answers: [] };
      const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        apiCalls.push(`${init?.method} ${url.pathname}`);
        if (init?.method === "GET" && url.pathname.endsWith(`/attempts/${attemptId}`))
          return Response.json({
            id: attemptId,
            userId,
            recordId,
            mode: "submit",
            state: "preparing",
            manifest,
            manifestHash: manifestHash(manifest),
            leaseOwner: "synthetic-owner",
            leaseGeneration: 1,
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          });
        if (init?.method === "GET" && url.pathname === `/api/personal/${recordId}`)
          return Response.json({
            id: recordId,
            title: "Synthetic Analyst",
            url: posting,
            identity,
            requisitionId: "123",
          });
        if (init?.method === "POST" && url.pathname.endsWith("/handoff/request")) {
          handoffs.push(JSON.parse(String(init.body)));
          return Response.json({ status: "awaiting_user" });
        }
        throw new Error("Unexpected synthetic API request");
      }) as typeof fetch;
      const broker = new PersonalBrowserBroker(
        {
          api: "http://127.0.0.1:9",
          token: "synthetic-token",
          attemptId,
          leaseOwner: "synthetic-owner",
          leaseGeneration: 1,
          root: f.root,
        },
        f.driver,
        request,
      );
      try {
        expect((await failureFrom(broker.inspectForm())).message).toContain(
          "requires user handling",
        );
        expect(handoffs).toEqual([
          {
            leaseOwner: "synthetic-owner",
            leaseGeneration: 1,
            reason: kind === "captcha" ? "captcha" : "login",
          },
        ]);
        expect(apiCalls.filter((call) => call.startsWith("POST"))).toEqual([
          `POST /api/personal/attempts/${attemptId}/handoff/request`,
        ]);
        expect(f.requests.every((request) => request.method === "GET")).toBe(true);
        expect(f.driver.submissionEvidence()).toBeUndefined();
        expect(f.page()).toBeUndefined();
      } finally {
        await broker.close();
        await f.close();
      }
    }, 15_000);
  }
  test("a form replaced by a visible challenge exposes no fill or submit controls", async () => {
    const f = await fixture(application());
    try {
      await f.driver.open(posting, f.root);
      expect((await f.driver.snapshot()).securityBlock).toBe(false);
      await f.page().evaluate((html) => {
        document.body.innerHTML = html;
      }, controls.otp);
      expect(await f.driver.snapshot()).toMatchObject({
        url: posting,
        securityBlock: true,
        fields: [],
        submitCount: 0,
      });
      expect(f.requests).toEqual([{ url: posting, method: "GET" }]);
    } finally {
      await f.close();
    }
  }, 15_000);
  test("hidden security controls and plain challenge words do not classify as a handoff", async () => {
    const f = await fixture(
      application(
        `<p>Login security challenge</p><div hidden>${controls.login}</div><div style="opacity:0">${controls.otp}</div>`,
      ),
    );
    try {
      await f.driver.open(posting, f.root);
      expect(await f.driver.snapshot()).toMatchObject({ securityBlock: false, submitCount: 1 });
    } finally {
      await f.close();
    }
  }, 15_000);
  test("missing form without a visible challenge remains an error", async () => {
    const f = await fixture(
      htmlDocument(`<div hidden>${controls.login}</div><p>Page unavailable</p>`),
    );
    try {
      expect((await failureFrom(f.driver.open(posting, f.root))).message).toContain(
        "waitForSelector",
      );
      expect(f.requests).toEqual([{ url: posting, method: "GET" }]);
      await expect(f.driver.snapshot()).rejects.toThrow("identity changed");
    } finally {
      await f.close();
    }
  }, 20_000);
  test("security controls after leaving the exact posting URL cannot bypass identity checks", async () => {
    const f = await fixture(application());
    try {
      await f.driver.open(posting, f.root);
      await f.page().evaluate((html) => {
        history.replaceState({}, "", "/other/jobs/123");
        document.body.innerHTML = html;
      }, controls.login);
      await expect(f.driver.snapshot()).rejects.toThrow("identity changed");
    } finally {
      await f.close();
    }
  }, 15_000);
  test("external redirect and mismatched loader identity remain blocked", async () => {
    for (const [html, status] of [
      [htmlDocument(controls.login), 302],
      [application("", { ...loader, jobPostId: "124" }), 200],
    ] as const) {
      const f = await fixture(html, status);
      try {
        await failureFrom(f.driver.open(posting, f.root));
        expect(f.requests).toEqual([{ url: posting, method: "GET" }]);
        expect(f.driver.submissionEvidence()).toBeUndefined();
      } finally {
        await f.close();
      }
    }
  }, 20_000);
});
