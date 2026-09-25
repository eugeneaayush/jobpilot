import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserDriver,
  PersonalBrowserBroker,
} from "../../../../../plugin/scripts/personal-browser/core";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const jobUrl = "https://synthetic.example.test/jobs/123";
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  return value;
}
class LifecycleDriver implements BrowserDriver {
  openCount = 0;
  closeCount = 0;
  live = false;
  openError?: Error;
  closeError?: Error;
  beforeClose?: () => Promise<void>;
  async open() {
    this.openCount += 1;
    this.live = true;
    if (this.openError) throw this.openError;
  }
  async snapshot() {
    if (!this.live) throw new Error("Synthetic browser is closed");
    return {
      url: jobUrl,
      text: "Synthetic Analyst",
      fields: [],
      submitCount: 0,
      securityBlock: false,
    };
  }
  async fill() {}
  async upload() {}
  async submit() {
    throw new Error("Lifecycle fixture never submits");
  }
  async close() {
    this.closeCount += 1;
    await this.beforeClose?.();
    if (this.closeError) throw this.closeError;
    this.live = false;
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "broker-lifecycle-synthetic-"));
  const manifest = {
    answers: [{ key: "name", fieldName: "first_name", value: "PRIVATE_ANSWER_CANARY" }],
    applicantEmail: "PRIVATE_APPLICANT_CANARY@example.test",
    document: { path: join(root, "PRIVATE_RESUME_CANARY.pdf"), sha256: "a".repeat(64) },
    attachments: [
      {
        path: join(root, "PRIVATE_ATTACHMENT_CANARY.pdf"),
        sha256: "b".repeat(64),
        fieldName: "cover_letter",
        label: "Cover letter",
        required: false,
      },
    ],
    canonicalUrl: jobUrl,
    identity: "greenhouse:synthetic:123",
  };
  const config = {
    root,
    attemptId,
    token: "PRIVATE_TOKEN_CANARY",
    api: "http://127.0.0.1:4101",
    leaseOwner: "synthetic-owner",
    leaseGeneration: 1,
  };
  const calls: string[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === `/api/personal/attempts/${attemptId}`)
      return Response.json({
        id: attemptId,
        userId,
        recordId,
        mode: "live_preview",
        state: "preparing",
        manifest,
        manifestHash: createHash("sha256")
          .update(JSON.stringify(sorted(manifest)))
          .digest("hex"),
        leaseOwner: config.leaseOwner,
        leaseGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    if (url.pathname === `/api/personal/${recordId}`)
      return Response.json({
        id: recordId,
        url: jobUrl,
        title: "Synthetic Analyst",
        identity: manifest.identity,
        requisitionId: "123",
      });
    throw new Error("Unexpected synthetic API request");
  }) as typeof fetch;
  const brokers: PersonalBrowserBroker[] = [];
  return {
    root,
    manifest,
    config,
    calls,
    ownerPath: join(root, "users", userId, "browser.lock", "owner.json"),
    broker(driver: LifecycleDriver) {
      const broker = new PersonalBrowserBroker(config, driver, request);
      brokers.push(broker);
      return broker;
    },
    async cleanup() {
      for (const broker of brokers) await broker.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Broker browser lifecycle and private diagnostics", () => {
  test("failed open waits for browser cleanup before releasing the owned profile", async () => {
    const f = await fixture();
    const finish = Promise.withResolvers<void>();
    try {
      const driver = new LifecycleDriver();
      const original = new Error("Synthetic startup failure after context creation");
      driver.openError = original;
      const closing = Promise.withResolvers<void>();
      driver.beforeClose = async () => {
        closing.resolve();
        await finish.promise;
      };
      const broker = f.broker(driver);
      const failed = broker.inspectForm().catch((error: unknown) => error);
      await closing.promise;
      const ownerBefore = await readFile(f.ownerPath, "utf8");
      expect(driver.live).toBe(true);
      const nextDriver = new LifecycleDriver();
      const next = f.broker(nextDriver);
      await expect(next.inspectForm()).rejects.toThrow("already in use");
      expect(nextDriver.openCount).toBe(0);
      expect(await readFile(f.ownerPath, "utf8")).toBe(ownerBefore);
      finish.resolve();
      expect(await failed).toBe(original);
      expect(driver.closeCount).toBe(1);
      expect(driver.live).toBe(false);
      await expect(access(f.ownerPath)).rejects.toThrow();
      expect((await next.inspectForm()).privacyScope).toBe("metadata_only");
      expect(nextDriver.openCount).toBe(1);
      await next.close();
      await next.inspectForm();
      expect(nextDriver.openCount).toBe(2);
      expect(f.calls.every((call) => call.startsWith("GET /api/personal/"))).toBe(true);
    } finally {
      finish.resolve();
      await f.cleanup();
    }
  });

  test("failed cleanup preserves original startup error and retains the profile lock", async () => {
    const f = await fixture();
    try {
      const driver = new LifecycleDriver();
      driver.openError = new Error("Original startup failure");
      driver.closeError = new Error("Cleanup failed; context may still be alive");
      const broker = f.broker(driver);
      expect(await broker.inspectForm().catch((error: unknown) => error)).toBe(driver.openError);
      expect(driver.live).toBe(true);
      const owner = await readFile(f.ownerPath, "utf8");
      const nextDriver = new LifecycleDriver();
      const next = f.broker(nextDriver);
      await expect(next.inspectForm()).rejects.toThrow("already in use");
      expect(nextDriver.openCount).toBe(0);
      await expect(broker.close()).rejects.toThrow("Cleanup failed");
      expect(await readFile(f.ownerPath, "utf8")).toBe(owner);
      driver.closeError = undefined;
      await broker.close();
      await next.inspectForm();
      expect(nextDriver.openCount).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("close never removes another owner's replacement lock", async () => {
    const f = await fixture();
    try {
      const broker = f.broker(new LifecycleDriver());
      await broker.inspectForm();
      const replacement = JSON.stringify({ nonce: "different-owner-nonce" });
      await writeFile(f.ownerPath, replacement);
      await broker.close();
      expect(await readFile(f.ownerPath, "utf8")).toBe(replacement);
      const nextDriver = new LifecycleDriver();
      await expect(f.broker(nextDriver).inspectForm()).rejects.toThrow("already in use");
      expect(nextDriver.openCount).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("broker diagnostics redact loaded answer, email, document, attachment and token canaries", async () => {
    const f = await fixture();
    try {
      const driver = new LifecycleDriver();
      const secrets = [
        f.manifest.answers[0]!.value,
        f.manifest.applicantEmail,
        f.manifest.document.path,
        f.manifest.attachments[0]!.path,
        f.config.token,
      ];
      driver.openError = new Error(`Synthetic failed open ${secrets.join(" ")}`);
      const broker = f.broker(driver);
      const original = await broker.inspectForm().catch((error: unknown) => error);
      expect(await broker.diagnose("inspect_form", original)).toBeUndefined();
      const raw = await readFile(join(f.root, "diagnostics", `${attemptId}.json`), "utf8");
      for (const secret of [...secrets, "PRIVATE_RESUME_CANARY", "PRIVATE_ATTACHMENT_CANARY"])
        expect(raw).not.toContain(secret);
      expect(JSON.parse(raw).error.message).toContain("Synthetic failed open");
      expect(JSON.parse(raw).error).not.toHaveProperty("stack");
    } finally {
      await f.cleanup();
    }
  });
});
