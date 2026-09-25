import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  HandoffBrowser,
  handoffRequestAllowed,
} from "../../../../../plugin/scripts/personal-browser/handoff";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const profileKey = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const handoffId = "44444444-4444-4444-8444-444444444444";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

async function rejectedOpen(browser: HandoffBrowser) {
  let failure: unknown;
  // Native await keeps Chromium's subprocess I/O outside Bun's rejection matcher.
  try {
    await browser.open();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

async function fixture(
  options: {
    challenge?: boolean;
    redirect?: boolean;
    expired?: boolean;
    invalidExpiry?: boolean;
    authRedirect?: 307 | 308;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "handoff-fixture-"));
  let outsideRequests = 0;
  let challenge = options.challenge ?? false;
  let revoked = false;
  const requests: string[] = [];
  const outside = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      outsideRequests++;
      return new Response("outside-canary");
    },
  });
  let origin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        if (request.headers.get("authorization") !== "Bearer synthetic-bearer")
          return new Response(null, { status: 401 });
        if (url.pathname.endsWith("/handoff"))
          return Response.json({
            handoffId,
            attemptId,
            recordId,
            profileKey,
            allowedOrigin: origin,
            status: "open",
            leaseOwner: "fixture-owner",
            leaseGeneration: revoked ? 3 : 2,
            leaseExpiresAt: options.invalidExpiry
              ? "not-a-date"
              : new Date(Date.now() + (options.expired ? -60_000 : 60_000)).toISOString(),
          });
        if (url.pathname === `/api/personal/attempts/${attemptId}`)
          return Response.json({
            id: attemptId,
            userId: profileKey,
            recordId,
            state: "blocked",
            mode: "live_preview",
            submitAt: null,
            manifestHash: hash("manifest"),
            manifest: { postingContentHash: hash("posting") },
          });
        if (url.pathname === `/api/personal/${recordId}`)
          return Response.json({
            id: recordId,
            title: "Synthetic Analyst",
            url: `${origin}/job`,
          });
        return new Response(null, { status: 404 });
      }
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/login" && request.method === "POST")
        return options.authRedirect
          ? Response.redirect(`${origin}/job`, options.authRedirect)
          : new Response("synthetic-authenticated");
      if (url.pathname === "/asset.js") return Response.redirect(outside.url.href, 302);
      if (url.pathname === "/job") {
        if (options.redirect) return Response.redirect(outside.url.href, 302);
        return new Response(
          `<h1>Synthetic Analyst</h1><p>PRIVATE_PAGE_CANARY</p><form action="/applications/submit" method="post"><input type="file" name="resume">${challenge ? '<input type="password" name="password">' : ""}<button>Apply</button></form><script src="/asset.js"></script><script>
          fetch('/applications/submit', {method:'POST'}).catch(()=>{});
          fetch('/auth/evil/apply', {method:'POST'}).catch(()=>{});
          new Image().src='/applications/submit';
          new Image().src='${outside.url}image';
        </script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("unexpected-route");
    },
  });
  origin = server.url.origin;
  const create = () =>
    new HandoffBrowser(
      {
        api: origin,
        token: "synthetic-bearer",
        attemptId,
        leaseOwner: "fixture-owner",
        leaseGeneration: 2,
        root,
      },
      handoffId,
      true,
    );
  return {
    root,
    requests,
    create,
    clear: () => {
      challenge = false;
    },
    revoke: () => {
      revoked = true;
    },
    outsideRequests: () => outsideRequests,
    close: async () => {
      server.stop(true);
      outside.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("local browser handoff isolation", () => {
  test("request policy blocks application actions, unknown auth routes, query drift and other origins", () => {
    const job = "https://example.test/job";
    const allowed = (path: string, method = "GET", resourceType = "fetch", navigation = false) =>
      handoffRequestAllowed(
        { url: new URL(path, job).href, method, resourceType, navigation },
        job,
      );
    expect(allowed("/login", "POST")).toBe(true);
    expect(allowed("/auth/login", "POST")).toBe(true);
    expect(allowed("/auth/apply", "POST")).toBe(false);
    expect(allowed("/applications/submit", "POST")).toBe(false);
    expect(allowed("/applications/submit", "GET", "image")).toBe(false);
    expect(allowed("/job?token=changed", "GET", "document", true)).toBe(false);
    expect(allowed("https://outside.test/login", "POST")).toBe(false);
  });

  test("real Chromium preserves exclusive profile and emits content-addressed proof without page data", async () => {
    const setup = await fixture({ challenge: true });
    const browser = setup.create();
    const duplicate = setup.create();
    try {
      await browser.open();
      expect((await rejectedOpen(duplicate)).message).toContain("EEXIST");
      expect(await browser.resume()).toBeNull();
      setup.clear();
      const proofHash = await browser.resume();
      if (!proofHash) throw new Error("Expected a verified synthetic browser proof");
      expect(proofHash).toMatch(/^[a-f0-9]{64}$/);
      const proof = await readFile(
        join(setup.root, "storage", profileKey, "handoffs", `${proofHash}.json`),
        "utf8",
      );
      expect(hash(proof)).toBe(proofHash);
      expect(JSON.parse(proof)).toMatchObject({
        handoffId,
        attemptId,
        recordId,
        noSubmission: true,
        securityClear: true,
        profileClosed: true,
      });
      expect(proof).not.toContain("PRIVATE_PAGE_CANARY");
      expect(proof).not.toContain("synthetic-bearer");
      expect(
        setup.requests.some(
          (request) => request.includes("/applications/submit") || request.includes("/auth/evil"),
        ),
      ).toBe(false);
      expect(setup.outsideRequests()).toBe(0);
      await expect(access(join(setup.root, "users", profileKey, "browser.lock"))).rejects.toThrow();
      await duplicate.open();
    } finally {
      await browser.close();
      await duplicate.close();
      await setup.close();
    }
  }, 30_000);

  test("real Chromium refuses an external redirect before the destination receives a request", async () => {
    const setup = await fixture({ redirect: true });
    const browser = setup.create();
    try {
      expect((await rejectedOpen(browser)).message).toContain("net::ERR_BLOCKED_BY_CLIENT");
      expect(setup.requests).toContain("GET /job");
      expect(setup.outsideRequests()).toBe(0);
    } finally {
      await browser.close();
      await setup.close();
    }
  }, 20_000);

  test("expired authority never starts browser navigation", async () => {
    const setup = await fixture({ expired: true });
    const browser = setup.create();
    try {
      expect((await rejectedOpen(browser)).message).toBe("Handoff lease unavailable");
      expect(setup.requests).toEqual([]);
    } finally {
      await browser.close();
      await setup.close();
    }
  });

  test("invalid lease expiry never starts browser navigation", async () => {
    const setup = await fixture({ invalidExpiry: true });
    const browser = setup.create();
    try {
      expect((await rejectedOpen(browser)).message).toBe("Handoff lease unavailable");
      expect(setup.requests).toEqual([]);
    } finally {
      await browser.close();
      await setup.close();
    }
  });

  test("revoked authority blocks a user auth POST before the server receives credentials", async () => {
    const setup = await fixture();
    const browser = setup.create();
    try {
      await browser.open();
      setup.revoke();
      // Test-only access drives this synthetic local page; production exposes no raw browser handle.
      const page = (browser as unknown as { page: Page }).page;
      const transmitted = await page.evaluate(() =>
        fetch("/login", { method: "POST", body: "synthetic-credential" }).then(
          () => true,
          () => false,
        ),
      );
      expect(transmitted).toBe(false);
      expect(setup.requests).not.toContain("POST /login");
      await expect(browser.resume()).rejects.toThrow();
    } finally {
      await browser.close();
      await setup.close();
    }
  }, 20_000);

  test("an authorized authentication response remains available for a separate verified navigation", async () => {
    const setup = await fixture();
    const browser = setup.create();
    try {
      await browser.open();
      const page = (browser as unknown as { page: Page }).page;
      const result = await page.evaluate(async () => {
        const response = await fetch("/login", { method: "POST", body: "synthetic-credential" });
        return { status: response.status, body: await response.text() };
      });
      expect(result).toEqual({ status: 200, body: "synthetic-authenticated" });
      expect(setup.requests.filter((request) => request === "POST /login")).toHaveLength(1);
      expect(setup.requests).not.toContain("POST /job");
      expect(await browser.resume()).toMatch(/^[a-f0-9]{64}$/);
      expect(setup.outsideRequests()).toBe(0);
    } finally {
      await browser.close();
      await setup.close();
    }
  }, 15_000);

  for (const status of [307, 308] as const) {
    test(`an authentication ${status} redirect cannot forward a POST to the job endpoint`, async () => {
      const setup = await fixture({ authRedirect: status });
      const browser = setup.create();
      try {
        await browser.open();
        const page = (browser as unknown as { page: Page }).page;
        const transmitted = await page.evaluate(() =>
          fetch("/login", { method: "POST", body: "synthetic-credential" }).then(
            () => true,
            () => false,
          ),
        );
        expect(setup.requests).not.toContain("POST /job");
        expect(transmitted).toBe(false);
        expect(setup.requests.filter((request) => request === "POST /login")).toHaveLength(1);
        expect(setup.requests).not.toContain("POST /applications/submit");
        expect(setup.outsideRequests()).toBe(0);
      } finally {
        await browser.close();
        await setup.close();
      }
    }, 15_000);
  }
});
