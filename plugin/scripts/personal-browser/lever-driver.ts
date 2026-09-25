/// <reference lib="dom" />
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
import type { BrowserDriver, DriverScope, Field, Snapshot, TransportReceipt } from "./core";
import { inspectLeverForm, type LeverField } from "./lever-form";
import {
  type LeverFinalContext,
  type LeverIdentity,
  parseLeverIdentity,
  validateLeverFinalRequest,
} from "./lever-network";

type Wire = { url: string; method: string; headers: Record<string, string>; body: Buffer | null };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export class LeverDriver implements BrowserDriver {
  private scope?: DriverScope;
  private identity?: LeverIdentity;
  private context?: BrowserContext;
  private page?: Page;
  private fields: LeverField[] = [];
  private hidden: Record<string, string> = {};
  private inventoryHash?: string;
  private approved: LeverFinalContext["approved"] = {};
  private files: LeverFinalContext["files"] = {};
  private assets = new Set<string>();
  private armed = false;
  private attempted = false;
  private sent = false;
  private loaded = false;
  private routeError?: string;
  private receipt?: TransportReceipt;
  private resolveResponse?: () => void;
  constructor(
    private readonly options: {
      headless?: boolean;
      transport?: (request: Wire) => Promise<Response>;
    } = {},
  ) {}
  configure(scope: DriverScope) {
    this.scope = scope;
  }
  acceptsUrl(value: string) {
    try {
      return (
        !!this.scope &&
        parseLeverIdentity(value, this.scope.identity).identity === this.scope.identity
      );
    } catch {
      return false;
    }
  }
  submissionEvidence() {
    return this.receipt;
  }
  // Hosted confirmation semantics have no public protocol oracle yet; even 2xx stays uncertain.
  confirmed() {
    return false;
  }
  answerMatches(field: Field, value: string | boolean) {
    if (field.type === "checkbox") return field.checked === value;
    const current = this.fields.find((item) => item.name === field.name);
    if (field.type === "select" && typeof value === "string") {
      const matches =
        current?.choices.filter((choice) => choice.value === value || choice.label === value) ?? [];
      return matches.length === 1 && field.value === matches[0]?.value;
    }
    return field.value === value;
  }
  private async forward(route: Route) {
    const request = route.request();
    const headers = {
      ...(request.headers()["content-type"]
        ? { "content-type": request.headers()["content-type"]! }
        : {}),
      origin: this.identity!.origin,
      referer: this.identity!.applyUrl,
      cookie: "",
    };
    let status: number, responseHeaders: Record<string, string>, bytes: Buffer;
    if (this.options.transport) {
      const response = await this.options.transport({
        url: request.url(),
        method: request.method(),
        headers,
        body: request.postDataBuffer(),
      });
      status = response.status;
      responseHeaders = Object.fromEntries(response.headers);
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      const response = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: 30_000,
        headers,
      });
      status = response.status();
      responseHeaders = response.headers();
      bytes = await response.body();
    }
    if ((status >= 300 && status < 400) || bytes.length > 10_000_000)
      throw new Error("needs_user: Lever redirect or oversized response requires review");
    return { status, headers: responseHeaders, bytes };
  }
  private async route(route: Route) {
    const request = route.request();
    try {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        this.identity &&
        ((!this.loaded && url.href === this.identity.applyUrl) ||
          (!this.attempted && this.assets.has(url.href)))
      ) {
        if (url.href === this.identity.applyUrl) this.loaded = true;
        const response = await this.forward(route);
        if (url.href === this.identity.applyUrl && !this.sent) {
          for (const match of response.bytes
            .toString("utf8")
            .matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
            const asset = new URL(match[1]!, this.identity.applyUrl);
            if (
              asset.origin === this.identity.origin &&
              /^\/static\/[a-zA-Z0-9_./-]+\.(?:js|css|woff2?)$/.test(asset.pathname) &&
              !asset.search &&
              !asset.hash
            )
              this.assets.add(asset.href);
          }
        }
        await route.fulfill({
          status: response.status,
          headers: response.headers,
          body: response.bytes,
        });
        return;
      }
      if (
        request.method() === "POST" &&
        this.armed &&
        !this.sent &&
        this.identity &&
        url.href === this.identity.applyUrl
      ) {
        this.armed = false;
        await this.scope!.authorize();
        const body = request.postDataBuffer();
        if (!body) throw new Error("Empty Lever application request");
        const proof = await validateLeverFinalRequest(
          { targetUrl: url.href, contentType: request.headers()["content-type"] ?? "", body },
          this.identity,
          { fields: this.fields, approved: this.approved, files: this.files, hidden: this.hidden },
        );
        await this.scope!.freeze(url.href, proof.frozenRequest);
        this.sent = true;
        const response = await this.forward(route);
        this.receipt = {
          targetUrl: url.href,
          requestBodyHash: proof.requestBodyHash,
          applicationPayloadHash: proof.applicationPayloadHash,
          responseStatus: response.status,
          responseBody: response.bytes.toString("utf8").slice(0, 100_000),
          capturedAt: new Date().toISOString(),
        };
        await route.fulfill({
          status: response.status,
          headers: response.headers,
          body: response.bytes,
        });
        this.resolveResponse?.();
        return;
      }
      await route.abort("blockedbyclient");
    } catch {
      this.routeError =
        "needs_user: Lever request failed validation or its bounded transport; do not retry after submission begins";
      this.resolveResponse?.();
      await route.abort("failed").catch(() => undefined);
    }
  }
  async open(value: string, profile: string) {
    if (!this.scope) throw new Error("Lever driver requires an immutable broker scope");
    this.identity = parseLeverIdentity(value, this.scope.identity);
    const { chromium } = await import("@playwright/test");
    this.context = await chromium.launchPersistentContext(profile, {
      headless: this.options.headless ?? true,
      acceptDownloads: false,
      serviceWorkers: "block",
      timeout: 10_000,
    });
    if (this.options.transport) await this.context.setOffline(true);
    await this.context.route("**/*", (route) => this.route(route));
    await this.context.routeWebSocket("**/*", (socket) => socket.close());
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    const response = await this.page.goto(this.identity.applyUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    if (!response || response.status() >= 400)
      throw new Error("needs_user: Lever hosted form is unavailable");
  }
  async snapshot(): Promise<Snapshot> {
    if (!this.page || !this.identity || !this.acceptsUrl(this.page.url()))
      throw new Error("needs_user: Lever page identity changed");
    const observed = await inspectLeverForm(this.page, randomUUID());
    if (
      !observed.securityBlock &&
      !this.sent &&
      (observed.unsupported ||
        observed.action !== this.identity.applyUrl ||
        observed.method !== "POST")
    )
      throw new Error("needs_user: Unsupported Lever hosted form shape requires an adapter review");
    if (!this.sent && !observed.securityBlock) {
      const fingerprint = hash(
        JSON.stringify({
          fields: observed.fields.map(
            ({ ref: _ref, value: _value, checked: _checked, fileHashes: _files, ...field }) =>
              field,
          ),
          hidden: observed.hidden,
        }),
      );
      if (this.inventoryHash && this.inventoryHash !== fingerprint)
        throw new Error(
          "needs_user: Lever question inventory changed; prepare a new source review",
        );
      this.inventoryHash = fingerprint;
      this.fields = observed.fields;
      this.hidden = observed.hidden;
    }
    return {
      url: this.page.url(),
      text: observed.text,
      fields: observed.fields,
      submitCount: observed.submitCount,
      securityBlock: observed.securityBlock,
      submitAction: observed.action,
      submitMethod: observed.method,
    };
  }
  private field(value: Field) {
    const field = this.fields.find((item) => item.ref === value.ref);
    if (!field || !/^[a-zA-Z0-9-]+$/.test(field.ref) || this.attempted || !this.page)
      throw new Error("needs_user: Lever field is stale or preparation is closed");
    return field;
  }
  async fill(value: Field, answer: string | boolean) {
    const field = this.field(value);
    const locator = this.page!.locator(`[data-jobpilot-ref="${field.ref}"]`);
    if ((await locator.count()) !== 1 || (await locator.getAttribute("name")) !== field.name)
      throw new Error("needs_user: Lever field identity changed");
    await this.scope!.authorize();
    if (field.type === "checkbox") {
      if (typeof answer !== "boolean")
        throw new Error("needs_user: Lever consent needs an explicit boolean");
      await locator.setChecked(answer);
      this.approved[field.name] = answer;
      return;
    }
    if (typeof answer !== "string") throw new Error("needs_user: Lever field needs explicit text");
    if (field.type === "select") {
      const choices = field.choices.filter(
        (choice) => choice.label === answer || choice.value === answer,
      );
      if (choices.length !== 1) throw new Error("needs_user: Lever choice is ambiguous");
      const selected = choices[0]!;
      if (field.widget === "radio")
        await this.page!.locator(`[data-jobpilot-lever-radio="${field.ref}"]`)
          .nth(field.choices.indexOf(selected))
          .check();
      else await locator.selectOption(selected.value);
      this.approved[field.name] = selected.value;
      return;
    }
    if (!["text", "email", "tel", "url", "number", "date", "textarea"].includes(field.type))
      throw new Error("needs_user: Unsupported Lever control");
    await locator.fill(answer);
    this.approved[field.name] = answer;
  }
  async upload(value: Field, path: string, bytes: Buffer) {
    const field = this.field(value);
    if (
      field.type !== "file" ||
      bytes.length > 10_000_000 ||
      bytes.subarray(0, 5).toString() !== "%PDF-"
    )
      throw new Error("needs_user: Lever requires a frozen PDF attachment");
    await this.scope!.authorize();
    this.files[field.name] = { filename: basename(path), sha256: hash(bytes), bytes: bytes.length };
    await this.page!.locator(`[data-jobpilot-ref="${field.ref}"]`).setInputFiles({
      name: basename(path),
      mimeType: "application/pdf",
      buffer: bytes,
    });
  }
  async submit() {
    if (this.attempted || !this.page || !this.identity)
      throw new Error("submission_uncertain: Lever submission cannot be retried");
    const snapshot = await this.snapshot();
    if (snapshot.securityBlock || snapshot.submitCount !== 1)
      throw new Error("needs_user: Lever final control or security state requires review");
    for (const field of this.fields)
      if (
        field.required &&
        (field.type === "file"
          ? !this.files[field.name]
          : !Object.hasOwn(this.approved, field.name))
      )
        throw new Error("needs_user: Required Lever question or document is unresolved");
    this.attempted = true;
    this.armed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<void>((resolve, reject) => {
      this.resolveResponse = resolve;
      timer = setTimeout(
        () => reject(new Error("submission_uncertain: Lever final response was not observed")),
        35_000,
      );
    });
    try {
      await this.page.locator('[data-jobpilot-lever-submit="true"]').click({ timeout: 10_000 });
      await response;
      if (this.routeError || !this.receipt)
        throw new Error(this.routeError ?? "submission_uncertain: Lever receipt is unavailable");
    } finally {
      if (timer) clearTimeout(timer);
      this.armed = false;
      this.resolveResponse = undefined;
    }
  }
  async close() {
    await this.context?.close();
  }
}
