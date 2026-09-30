import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { BrowserContext, Page } from "@playwright/test";
import type { BrokerConfig } from "./core";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9-]{36}$/i;
const authenticationPath =
  /^\/(?:login|signin|sign-in|sign_in|session|sessions|verify|verification|register|signup|sign-up|auth(?:\/(?:login|signin|callback|verify))?|oauth(?:\/(?:authorize|callback|token))?)\/?$/i;
const applicationPath = /\/(?:apply|applications?|submissions?)(?:\/|$)/i;

export function handoffRequestAllowed(
  request: { url: string; method: string; navigation: boolean; resourceType: string },
  jobUrl: string,
) {
  const url = new URL(request.url);
  const job = new URL(jobUrl);
  if (url.origin !== job.origin || url.username || url.password) return false;
  if (applicationPath.test(url.pathname) && url.href !== job.href) return false;
  const authentication =
    authenticationPath.test(url.pathname) && !applicationPath.test(url.pathname);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
    return request.method === "POST" && authentication;
  if (request.navigation)
    return authentication || (url.pathname === job.pathname && url.search === job.search);
  return (
    ["stylesheet", "script", "image", "font", "media"].includes(request.resourceType) ||
    authentication ||
    url.href === job.href
  );
}

interface HandoffScope {
  handoffId: string;
  attemptId: string;
  recordId: string;
  profileKey: string;
  allowedOrigin: string;
  status: string;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
}
interface AttemptScope {
  id: string;
  userId: string;
  recordId: string;
  state: string;
  mode: string;
  submitAt: string | null;
  manifestHash: string;
  manifest: { postingContentHash: string };
}
interface RecordScope {
  id: string;
  url: string;
  title: string;
}

export class HandoffBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private lockPath?: string;
  private nonce = randomUUID();
  private scope?: HandoffScope;
  private attempt?: AttemptScope;
  private record?: RecordScope;
  private deadline = Date.now() + 15 * 60_000;
  constructor(
    private readonly config: BrokerConfig,
    private readonly handoffId: string,
    private readonly headless = false,
  ) {
    const api = new URL(config.api);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
      !["http:", "https:"].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.pathname !== "/" ||
      api.search ||
      api.hash ||
      !uuid.test(config.attemptId) ||
      !uuid.test(handoffId) ||
      !isAbsolute(config.root)
    )
      throw new Error("Invalid handoff scope");
  }
  private async api(path: string, body?: unknown) {
    const response = await fetch(`${this.config.api.replace(/\/$/, "")}/api/personal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Handoff scope unavailable");
    return response.json();
  }
  private async authorize() {
    const scope = (await this.api(`/attempts/${this.config.attemptId}/handoff`)) as HandoffScope;
    if (
      scope.handoffId !== this.handoffId ||
      scope.attemptId !== this.config.attemptId ||
      scope.status !== "open" ||
      scope.leaseOwner !== this.config.leaseOwner ||
      scope.leaseGeneration !== this.config.leaseGeneration ||
      !Number.isFinite(Date.parse(scope.leaseExpiresAt)) ||
      Date.parse(scope.leaseExpiresAt) <= Date.now() ||
      Date.now() >= this.deadline ||
      !uuid.test(scope.profileKey)
    )
      throw new Error("Handoff lease unavailable");
    const attempt = (await this.api(`/attempts/${scope.attemptId}`)) as AttemptScope;
    if (
      attempt.state !== "blocked" ||
      attempt.submitAt ||
      attempt.mode === "offline" ||
      attempt.userId !== scope.profileKey ||
      attempt.recordId !== scope.recordId ||
      attempt.id !== scope.attemptId
    )
      throw new Error("Attempt cannot use a browser handoff");
    const record = (await this.api(`/${scope.recordId}`)) as RecordScope;
    if (
      record.id !== scope.recordId ||
      new URL(record.url).origin !== scope.allowedOrigin ||
      (this.record && this.record.url !== record.url) ||
      (this.attempt && this.attempt.manifestHash !== attempt.manifestHash)
    )
      throw new Error("Handoff requisition changed");
    await this.api(`/attempts/${scope.attemptId}/handoff/authorize`, {
      handoffId: scope.handoffId,
      leaseOwner: scope.leaseOwner,
      leaseGeneration: scope.leaseGeneration,
    });
    this.scope = scope;
    this.attempt = attempt;
    this.record = record;
  }
  async open() {
    await this.authorize();
    if (this.context) throw new Error("Handoff browser already open");
    const directory = join(this.config.root, "users", this.scope!.profileKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lock = join(directory, "browser.lock");
    await mkdir(lock, { mode: 0o700 });
    this.lockPath = lock;
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        attemptId: this.attempt!.id,
        handoffId: this.handoffId,
        leaseOwner: this.config.leaseOwner,
        pid: process.pid,
        nonce: this.nonce,
      }),
      { mode: 0o600 },
    );
    const { chromium } = await import("@playwright/test");
    this.context = await chromium.launchPersistentContext(join(directory, "browser-profile"), {
      headless: this.headless,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      timeout: 10_000,
    });
    await this.context.clearPermissions();
    await this.context.routeWebSocket("**/*", (socket) => socket.close());
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      try {
        await this.authorize();
      } catch {
        return route.abort("blockedbyclient");
      }
      if (
        !handoffRequestAllowed(
          {
            url: request.url(),
            method: request.method(),
            navigation: request.isNavigationRequest(),
            resourceType: request.resourceType(),
          },
          this.record!.url,
        )
      )
        return route.abort("blockedbyclient");
      const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
      // Browser-followed redirects can preserve a POST while bypassing route interception.
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
        response.status() >= 300 &&
        response.status() < 400
      )
        return route.abort("blockedbyclient");
      const location = response.headers().location;
      if (location) {
        const destination = new URL(location, request.url()).href;
        if (
          !handoffRequestAllowed(
            { url: destination, method: "GET", navigation: true, resourceType: "document" },
            this.record!.url,
          )
        )
          return route.abort("blockedbyclient");
      }
      return route.fulfill({ response });
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(this.record!.url, { waitUntil: "domcontentloaded", timeout: 12_000 });
  }
  async resume(): Promise<string | null> {
    await this.authorize();
    if (!this.page || !this.context || !this.record || !this.attempt || !this.scope)
      throw new Error("Handoff browser is closed");
    await this.page.goto(this.record.url, { waitUntil: "domcontentloaded", timeout: 12_000 });
    const snapshot = await this.page.evaluate(() => {
      const visible = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const challenge = Array.from(
        document.querySelectorAll(
          'input[type="password"], [id*="captcha"], [class*="captcha"], iframe',
        ),
      ).some(visible);
      const text = document.body.innerText;
      const application =
        Array.from(document.querySelectorAll('input[type="file"]')).some(visible) &&
        Array.from(document.querySelectorAll("form")).some(visible);
      return { url: location.href, challenge, text, application };
    });
    if (
      snapshot.url !== this.record.url ||
      snapshot.challenge ||
      !snapshot.application ||
      !snapshot.text.toLowerCase().includes(this.record.title.toLowerCase()) ||
      /connection is not private|verify you are human|verification code|one.time (?:code|password)/i.test(
        snapshot.text,
      )
    )
      return null;
    const proof = {
      handoffId: this.handoffId,
      attemptId: this.attempt.id,
      recordId: this.record.id,
      manifestHash: this.attempt.manifestHash,
      postingContentHash: this.attempt.manifest.postingContentHash,
      leaseGeneration: this.scope.leaseGeneration,
      sourceUrl: this.record.url,
      noSubmission: true,
      securityClear: true,
      applicationFormObserved: true,
      profileClosed: true,
      capturedAt: new Date().toISOString(),
    };
    await this.close();
    const bytes = JSON.stringify(proof, null, 2);
    const proofHash = hash(bytes);
    const directory = join(this.config.root, "storage", this.attempt.userId, "handoffs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${proofHash}.json`), bytes, { flag: "wx", mode: 0o600 });
    return proofHash;
  }
  async close() {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
    if (this.lockPath) {
      const owner = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8"));
      if (owner.nonce === this.nonce) await rm(this.lockPath, { recursive: true });
      this.lockPath = undefined;
    }
  }
}

export async function runHandoff(config: BrokerConfig, handoffId: string) {
  const browser = new HandoffBrowser(config, handoffId);
  const emit = (type: string, proofHash?: string) =>
    process.stdout.write(`${JSON.stringify({ type, ...(proofHash ? { proofHash } : {}) })}\n`);
  const close = async () => {
    await browser.close();
  };
  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
  const timer = setTimeout(() => {
    void close().finally(() => process.exit(0));
  }, 15 * 60_000);
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      try {
        if (line.length > 100) throw new Error("Invalid command");
        const input = JSON.parse(line);
        if (Object.keys(input).length !== 1) throw new Error("Invalid command");
        if (input.type === "open") {
          await browser.open();
          emit("ready");
        } else if (input.type === "resume") {
          const proofHash = await browser.resume();
          emit(proofHash ? "resolved" : "blocked", proofHash ?? undefined);
          if (proofHash) break;
        } else if (input.type === "cancel") {
          await close();
          emit("closed");
          break;
        } else throw new Error("Invalid command");
      } catch {
        await close();
        emit("blocked");
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    await close();
  }
}
