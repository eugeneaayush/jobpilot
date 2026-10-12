/// <reference lib="dom" />
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
import type { BrowserDriver, DriverScope, Field, Snapshot, TransportReceipt } from "./core";
import {
  fillGreenhouseField,
  type GreenhouseField,
  inspectGreenhouseForm,
  uploadGreenhouseFile,
} from "./greenhouse-form";
import {
  classifyGreenhouseResponse,
  type GreenhouseIdentity,
  type GreenhousePresign,
  type GreenhouseUploadedFile,
  isGreenhouseConfirmationEvidence,
  parseGreenhouseIdentity,
  validateGreenhouseFinalRequest,
  validateGreenhousePresign,
  validateGreenhouseUpload,
} from "./greenhouse-network";
import {
  finishGreenhouseUploadProgress,
  installGreenhouseUploadProgress,
} from "./greenhouse-upload";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hosts = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);
export function isGreenhousePosting(value: string, identity: string) {
  try {
    const url = new URL(value);
    const match = /^\/([a-z0-9_-]+)\/jobs\/(\d+)\/?$/.exec(url.pathname);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hosts.has(url.host) &&
      !!match &&
      identity === `greenhouse:${match[1]}:${match[2]}`
    );
  } catch {
    return false;
  }
}
interface Upload {
  fieldName: string;
  name: string;
  sha256: string;
  url?: string;
  presign?: GreenhousePresign;
  completed: boolean;
  transferredBytes?: number;
  field: GreenhouseField;
}
interface WireRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}
type TestTransport = (request: WireRequest) => Promise<Response>;

// Only tests inject a transport or a shorter form wait; production always uses the browser's
// bounded requests and the 15 s wait.
export class GreenhouseDriver implements BrowserDriver {
  private scope?: DriverScope;
  private context?: BrowserContext;
  private page?: Page;
  private identity?: GreenhouseIdentity;
  private filled: Record<string, string | boolean | string[]> = {};
  private selections: Record<string, { label: string; value: string }> = {};
  private presigns: Record<string, GreenhousePresign> = {};
  private initialUrl = "";
  private fields: GreenhouseField[] = [];
  private uploads = new Map<string, Upload>();
  private timeZone = "";
  private assets = new Set<string>();
  private geoKey?: string;
  private locations: {
    label: string;
    latitude: string;
    longitude: string;
    countryShortName: string;
    value: string;
  }[] = [];
  private location?: {
    label: string;
    latitude: string;
    longitude: string;
    countryShortName: string;
  };
  private phoneCountryDialCode?: string;
  private lookup?: { name: string; value: string };
  private armed = false;
  private sent = false;
  private receipt?: TransportReceipt;
  private pendingResponse?: Promise<void>;
  private resolveResponse?: () => void;
  private routeError?: string;
  constructor(
    private readonly options: {
      headless?: boolean;
      transport?: TestTransport;
      formTimeout?: number;
    } = {},
  ) {}
  configure(scope: DriverScope) {
    this.scope = scope;
  }
  acceptsUrl(value: string) {
    if (!this.scope) return false;
    try {
      const url = new URL(value);
      if (url.pathname.endsWith("/confirmation"))
        url.pathname = url.pathname.replace(/\/confirmation$/, "");
      return isGreenhousePosting(url.href, this.scope.identity);
    } catch {
      return false;
    }
  }
  answerMatches(field: Field, value: string | boolean | string[]) {
    if (Array.isArray(value))
      return (
        !!field.multiple &&
        field.selectedValues?.length === value.length &&
        value.every((item) => field.selectedValues!.includes(item))
      );
    if (field.type === "checkbox") return field.checked === value;
    if (field.value === value) return true;
    const choices = this.identity?.choices[field.name] ?? [];
    const choice = choices.find(
      (item) =>
        (item.value === value || item.label === value) &&
        (item.value === field.value || item.label === field.value),
    );
    if (choice) return true;
    if (field.name === "country" && typeof value === "string" && this.phoneCountryDialCode)
      return field.value === value.replace(/ \+\d+$/, "");
    if (field.name === "phone" && typeof value === "string") {
      const digits = (text: string) => text.replace(/[^0-9]/g, "");
      const expected = digits(value);
      const observed = digits(field.value);
      return (
        expected === observed ||
        (!!this.phoneCountryDialCode &&
          value.startsWith("+") &&
          expected === this.phoneCountryDialCode + observed)
      );
    }
    return false;
  }
  submissionEvidence() {
    return this.receipt;
  }
  confirmed() {
    return (
      !!this.receipt &&
      !!this.identity &&
      !!this.page &&
      isGreenhouseConfirmationEvidence(this.identity, this.receipt, this.page.url(), this.receipt)
    );
  }
  private async forward(route: Route) {
    const request = route.request();
    const destination = new URL(request.url());
    const controlledPost = !["www.recaptcha.net", "www.gstatic.com"].includes(destination.host);
    const headers = controlledPost
      ? {
          ...(request.headers()["content-type"]
            ? { "content-type": request.headers()["content-type"]! }
            : {}),
          origin: "https://job-boards.greenhouse.io",
          referer: `https://job-boards.greenhouse.io/${this.identity?.board}/jobs/${this.identity?.postId}`,
          cookie: "",
          ...(request.method() === "OPTIONS"
            ? {
                "access-control-request-method": "POST",
                ...(request
                  .headers()
                  ["access-control-request-headers"]?.split(",")
                  .some((key) => key.trim().toLowerCase() === "content-type")
                  ? { "access-control-request-headers": "content-type" }
                  : {}),
              }
            : {}),
        }
      : request.headers();
    if (this.options.transport) {
      const response = await this.options.transport({
        url: request.url(),
        method: request.method(),
        headers,
        body: request.postDataBuffer(),
      });
      if (response.status >= 300 && response.status < 400 && response.headers.has("location"))
        throw new Error("Greenhouse HTTP redirects require a fresh source review");
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: Object.fromEntries(response.headers), bytes };
    }
    const response = await route.fetch({
      maxRedirects: 0,
      maxRetries: 0,
      timeout: 15_000,
      headers,
    });
    if (response.status() >= 300 && response.status() < 400 && response.headers().location)
      throw new Error("Greenhouse HTTP redirects require a fresh source review");
    return { status: response.status(), headers: response.headers(), bytes: await response.body() };
  }
  private allowedGet(url: URL, _type: string) {
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (hosts.has(url.host) && this.acceptsUrl(url.href)) {
      const initial = new URL(this.initialUrl);
      return [...url.searchParams].every(
        ([key, value]) =>
          initial.searchParams.get(key) === value || (key === "_data" && /^routes\//.test(value)),
      );
    }
    if (url.host === "job-boards.cdn.greenhouse.io") return this.assets.has(url.href);
    if (url.host === "www.gstatic.com")
      return (
        /^\/recaptcha\/releases\/[a-zA-Z0-9_-]+\/recaptcha__[a-z_]+\.js$/.test(url.pathname) &&
        !url.search
      );
    if (
      url.host === "www.recaptcha.net" &&
      /^\/recaptcha\/(?:enterprise\.js|enterprise\/(?:anchor|bframe|webworker\.js))$/.test(
        url.pathname,
      )
    )
      return [...url.searchParams.keys()].every((key) =>
        [
          "render",
          "onload",
          "hl",
          "ar",
          "k",
          "co",
          "v",
          "size",
          "cb",
          "anchor-ms",
          "execute-ms",
          "afrm",
          "sa",
        ].includes(key),
      );
    if (
      url.host === "boards.greenhouse.io" &&
      url.pathname === "/uncacheable_attributes/presigned_fields"
    )
      return (
        !this.sent &&
        url.searchParams.getAll("fields[]").length > 0 &&
        [...url.searchParams].every(
          ([key, value]) =>
            key === "fields[]" &&
            (["resume", "cover_letter"].includes(value) ||
              this.fields.some((field) => field.name === value && field.type === "file")),
        )
      );
    if (
      url.host === "boards.greenhouse.io" &&
      this.identity &&
      new RegExp(
        `^/v1/boards/${this.identity.board}/education/(schools|degrees|disciplines)$`,
      ).test(url.pathname)
    )
      return (
        !!this.lookup &&
        ["school_name", "degree", "discipline"].includes(this.lookup.name) &&
        url.searchParams.get("term") === this.lookup.value &&
        [...url.searchParams.keys()].every((key) => ["term", "page"].includes(key))
      );
    if (url.host === "api-geocode-earth-proxy.greenhouse.io" && url.pathname === "/v1/autocomplete")
      return (
        this.lookup?.name === "location" &&
        !!this.geoKey &&
        url.searchParams.get("api_key") === this.geoKey &&
        url.searchParams.get("text") === this.lookup.value &&
        url.searchParams.get("layers") === "locality" &&
        url.searchParams.get("lang") === "en" &&
        [...url.searchParams.keys()].every((key) =>
          ["api_key", "text", "layers", "lang"].includes(key),
        )
      );
    // Email validation, analytics, Quick Apply and unrecognized data-bearing requests are denied.
    return false;
  }
  private async route(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    try {
      if (
        ["GET", "HEAD"].includes(request.method()) &&
        this.allowedGet(url, request.resourceType())
      ) {
        if (this.lookup || url.pathname.endsWith("presigned_fields")) await this.scope!.authorize();
        const response = await this.forward(route);
        // Presign and autocomplete responses are inspected before their bytes reach page code.
        await this.capturePreparation(url, response);
        await route.fulfill({
          status: response.status,
          headers: response.headers,
          body: response.bytes,
        });
        return;
      }
      if (
        request.method() === "OPTIONS" &&
        this.identity &&
        (url.href === this.identity.targetUrl ||
          [...this.uploads.values()].some(
            (upload) =>
              !upload.completed &&
              this.presigns[upload.fieldName] &&
              new URL(this.presigns[upload.fieldName]!.url).href === url.href,
          ))
      ) {
        await this.scope!.authorize();
        const response = await this.forward(route);
        await route.fulfill({
          status: response.status,
          headers: response.headers,
          body: response.bytes,
        });
        return;
      }
      if (request.method() === "POST" && (await this.uploadRequest(route))) return;
      if (
        request.method() === "POST" &&
        this.identity &&
        url.href === this.identity.targetUrl &&
        this.armed &&
        !this.sent
      ) {
        this.armed = false;
        await this.scope!.authorize();
        const body = request.postDataBuffer();
        if (
          !body ||
          body.length > 2_000_000 ||
          !request.headers()["content-type"]?.startsWith("application/json")
        )
          throw new Error("Invalid Greenhouse final payload");
        const applicationPayloadHash = this.validateFinal(body);
        await this.scope!.freeze(url.href, body.toString("utf8"));
        this.sent = true;
        const response = await this.forward(route);
        this.receipt = {
          targetUrl: url.href,
          requestBodyHash: hash(body),
          applicationPayloadHash,
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
      if (
        request.method() === "POST" &&
        this.armed &&
        url.host === "www.recaptcha.net" &&
        /^\/recaptcha\/enterprise\/(reload|clr)$/.test(url.pathname)
      ) {
        const response = await this.forward(route);
        await route.fulfill({
          status: response.status,
          headers: response.headers,
          body: response.bytes,
        });
        return;
      }
      await route.abort("blockedbyclient");
    } catch (error) {
      this.routeError = error instanceof Error ? error.message : "Bounded request failed";
      this.resolveResponse?.();
      await route.abort("failed").catch(() => undefined);
    }
  }
  private async capturePreparation(
    url: URL,
    response: { status: number; headers: Record<string, string>; bytes: Buffer },
  ) {
    if (
      response.status === 200 &&
      (hosts.has(url.host) || url.host === "job-boards.cdn.greenhouse.io")
    ) {
      const source = response.bytes.toString("utf8");
      const names = source.matchAll(
        /(?:https:\/\/job-boards\.cdn\.greenhouse\.io\/assets\/|["']\.\/)([a-zA-Z0-9_$.-]+-[a-zA-Z0-9_-]{8}\.(?:js|css|woff2?))/g,
      );
      for (const match of names)
        this.assets.add(`https://job-boards.cdn.greenhouse.io/assets/${match[1]}`);
      // Remix publishes exact locale hashes in its entry bundle. Hydration waits for
      // these resources; allow only the pinned English namespaces, never an open CDN.
      if (url.host === "job-boards.cdn.greenhouse.io" && /\/entry\.client-/.test(url.pathname)) {
        for (const match of source.matchAll(
          /"locales\/en\/(common|job_post|confirmation)\.json":"([a-zA-Z0-9_-]{43})"/g,
        ))
          this.assets.add(
            `https://job-boards.cdn.greenhouse.io/locales/en/${match[1]}.${match[2]}.json`,
          );
      }
    }
    if (url.pathname === "/uncacheable_attributes/presigned_fields" && response.status === 200) {
      const entries = validateGreenhousePresign(url.href, response.bytes.toString("utf8"), [
        "resume",
        "cover_letter",
        ...this.fields.filter((field) => field.type === "file").map((field) => field.name),
      ]);
      Object.assign(this.presigns, entries);
    }
    if (
      this.lookup?.name === "location" &&
      url.host === "api-geocode-earth-proxy.greenhouse.io" &&
      response.status === 200
    ) {
      const body = JSON.parse(response.bytes.toString("utf8"));
      if (!Array.isArray(body.features)) throw new Error("Unrecognized location response");
      this.locations = body.features.flatMap(
        (feature: { properties: Record<string, string>; geometry: { coordinates: number[] } }) => {
          const p = feature.properties;
          const coordinates = feature.geometry?.coordinates;
          if (
            !p ||
            !Array.isArray(coordinates) ||
            coordinates.length !== 2 ||
            !coordinates.every(Number.isFinite)
          )
            return [];
          let label = p.label ?? "";
          const parts = label.split(",");
          if (["locality", "borough"].includes(p.layer ?? "")) {
            if (parts.length === 2) label = `${parts[0]?.trim()}, ${p.country}`;
            if (parts.length === 3)
              label = `${parts[0]?.trim()}, ${[p.macroregion, p.macroregion_a].includes(parts[1]?.trim() ?? "") ? p.macroregion : p.region}, ${p.country}`;
          } else if (p.layer === "region") label = `${p.macroregion || p.region}, ${p.country}`;
          else if (p.layer === "country") label = p.country ?? "";
          if (!label || !p.id || !p.country_code) return [];
          return [
            {
              label,
              value: p.id,
              latitude: String(coordinates[1]),
              longitude: String(coordinates[0]),
              countryShortName: p.country_code,
            },
          ];
        },
      );
      if (this.identity)
        this.identity.choices.location = this.locations.map(({ label, value }) => ({
          label,
          value,
        }));
    }
    if (
      this.lookup &&
      this.identity &&
      url.pathname.includes("/education/") &&
      response.status === 200
    ) {
      const body = JSON.parse(response.bytes.toString("utf8"));
      const values = Array.isArray(body) ? body : body.items;
      if (!Array.isArray(values)) throw new Error("Unrecognized education lookup response");
      const choices = values.flatMap((item: Record<string, unknown>) => {
        const label = item.text ?? item.name ?? item.label;
        const value = item.id ?? item.value;
        return typeof label === "string" && (typeof value === "number" || typeof value === "string")
          ? [{ label, value: String(value) }]
          : [];
      });
      this.identity.choices[this.lookup.name] = choices;
      const active = this.fields.find((field) => field.name === this.lookup?.name);
      if (active) active.trustedChoices = choices;
    }
  }
  private async uploadRequest(route: Route): Promise<boolean> {
    const request = route.request();
    const matches = [...this.uploads.values()].filter(
      (upload) =>
        !upload.completed &&
        this.presigns[upload.fieldName] &&
        new URL(this.presigns[upload.fieldName]!.url).href === request.url(),
    );
    if (matches.length !== 1 || !matches[0]) return false;
    const upload = matches[0];
    await this.scope!.authorize();
    const body = request.postDataBuffer();
    if (!body) throw new Error("Empty Greenhouse upload");
    const verified = validateGreenhouseUpload(
      request.headers()["content-type"] ?? "",
      body,
      this.presigns[upload.fieldName]!,
      upload,
    );
    const response = await this.forward(route);
    if (response.status < 200 || response.status >= 300)
      throw new Error("Greenhouse attachment staging failed");
    upload.url = verified.url;
    await route.fulfill({
      status: response.status,
      headers: response.headers,
      body: response.bytes,
    });
    upload.transferredBytes = body.length;
    upload.completed = true;
    return true;
  }
  private validateFinal(body: Buffer): string {
    if (!this.identity) throw new Error("Missing Greenhouse identity");
    const uploads = [...this.uploads.values()].map((upload) => {
      if (!upload.completed || !upload.url) throw new Error("Upload was not verified");
      return { ...upload, url: upload.url } as GreenhouseUploadedFile;
    });
    return validateGreenhouseFinalRequest(body, this.identity, {
      fields: {
        ...this.filled,
        ...(this.filled.location ? { candidate_location: this.filled.location } : {}),
      },
      uploads,
      timeZone: this.timeZone,
      selections: this.selections,
      location: this.location,
      phoneCountryDialCode: this.phoneCountryDialCode,
    }).applicationPayloadHash;
  }
  async open(url: string, profile: string) {
    if (!this.scope || !isGreenhousePosting(url, this.scope.identity))
      throw new Error("Invalid Greenhouse posting scope");
    if (this.sent) throw new Error("A sent Greenhouse request cannot reopen a preparation session");
    if (this.context) throw new Error("Greenhouse browser session is already open");
    this.filled = {};
    this.selections = {};
    this.presigns = {};
    this.fields = [];
    this.uploads.clear();
    this.assets.clear();
    this.locations = [];
    this.location = undefined;
    this.geoKey = undefined;
    this.phoneCountryDialCode = undefined;
    this.lookup = undefined;
    this.identity = undefined;
    this.receipt = undefined;
    this.routeError = undefined;
    this.armed = false;
    this.pendingResponse = undefined;
    this.resolveResponse = undefined;
    // Browser-followed redirects skip routing; enter the same posting on its hosted origin.
    const hosted = new URL(url);
    hosted.hostname = "job-boards.greenhouse.io";
    this.initialUrl = hosted.href;
    const { chromium } = await import("@playwright/test");
    this.context = await chromium.launchPersistentContext(profile, {
      headless: this.options.headless ?? true,
      timeout: 10_000,
      acceptDownloads: false,
      locale: "en-US",
      serviceWorkers: "block",
      // A test transport means no real host may be reached: browser-followed redirects skip
      // routing, and setOffline from inside a route deadlocks the paused navigation.
      ...(this.options.transport && { args: ["--host-resolver-rules=MAP * ~NOTFOUND"] }),
    });
    await installGreenhouseUploadProgress(this.context);
    await this.context.route("**/*", (route) => this.route(route));
    await this.context.routeWebSocket("**/*", (socket) => socket.close());
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    const response = await this.page.goto(this.initialUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    if (!response) throw new Error("Greenhouse hosted origin did not serve the frozen posting");
    if (await this.securitySnapshot()) return;
    if (response.status() >= 400)
      throw new Error("Greenhouse hosted origin did not serve the frozen posting");
    try {
      await this.initializeForm();
    } catch (error) {
      if (await this.securitySnapshot()) return;
      throw error;
    }
  }
  private async initializeForm() {
    if (!this.page) throw new Error("Greenhouse browser is not open");
    await this.page.waitForSelector("form#application-form.application--form", {
      timeout: this.options.formTimeout ?? 15_000,
    });
    const loader = await this.page.evaluate(() => {
      const data = (
        window as unknown as {
          __remixContext?: { state?: { loaderData?: Record<string, unknown> } };
        }
      ).__remixContext?.state?.loaderData;
      return {
        data,
        env: (
          data?.root as {
            ENV?: { LOCATION_CONTROL_API_KEY?: string; LOCATION_CONTROL_BASE_URL?: string };
          }
        )?.ENV,
      };
    });
    this.identity = this.parseIdentity(loader.data);
    this.timeZone = await this.page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (
      [
        "https://api-geocode-earth-proxy.greenhouse.io",
        "https://api-geocode-earth-proxy.greenhouse.io/",
      ].includes(loader.env?.LOCATION_CONTROL_BASE_URL ?? "")
    )
      this.geoKey = loader.env?.LOCATION_CONTROL_API_KEY;
    // SSR controls are visible before React attaches handlers. Probe only the empty
    // country menu; no applicant value is entered and no lookup is authorized here.
    const country = this.page.locator('form#application-form #country[role="combobox"]');
    if ((await country.count()) === 1) {
      const deadline = Date.now() + 10_000;
      while ((await country.getAttribute("aria-expanded")) !== "true") {
        if (Date.now() > deadline) throw new Error("Greenhouse form did not become interactive");
        await country.click({ timeout: 2000 });
        if ((await country.getAttribute("aria-expanded")) !== "true")
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await country.press("Escape");
    }
  }
  private parseIdentity(loader: unknown) {
    return parseGreenhouseIdentity(this.page!.url(), loader, this.scope!.identity);
  }
  private async securitySnapshot(): Promise<Snapshot | undefined> {
    // A challenge can replace the form before its loader supplies application identity.
    if (
      !this.page ||
      !this.scope ||
      this.page.url() !== this.initialUrl ||
      !isGreenhousePosting(this.page.url(), this.scope.identity)
    )
      return;
    const blocked = await this.page
      .locator('input[type="password"],iframe[src*="bframe"],input[autocomplete="one-time-code"]')
      .evaluateAll((elements) =>
        elements.some((element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 10 || rect.height <= 10) return false;
          for (let current: Element | null = element; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              style.display === "none" ||
              Number(style.opacity) === 0
            )
              return false;
          }
          return true;
        }),
      );
    if (!blocked) return;
    return {
      url: this.page.url(),
      text: await this.page.locator("body").innerText(),
      fields: [],
      submitCount: 0,
      securityBlock: true,
    };
  }
  async snapshot(): Promise<Snapshot> {
    if (!this.page || !this.acceptsUrl(this.page.url()))
      throw new Error("Greenhouse page identity changed");
    const security = await this.securitySnapshot();
    if (security) return security;
    if (!this.identity) throw new Error("Greenhouse page identity changed");
    if (this.confirmed())
      return {
        url: this.page.url(),
        text: await this.page.locator("body").innerText(),
        fields: [],
        submitCount: 0,
        securityBlock: false,
      };
    const form = await inspectGreenhouseForm(this.page, randomUUID(), this.identity.choices);
    if (!form) throw new Error("Greenhouse application form disappeared");
    this.fields = form.fields;
    for (const upload of this.uploads.values()) {
      if (!upload.completed || this.fields.some((field) => field.name === upload.fieldName))
        continue;
      const retained = await this.page.locator("form#application-form .file-upload").evaluateAll(
        (groups, expected) => {
          const matches = groups.filter(
            (group) =>
              group.getAttribute("aria-labelledby") === `upload-label-${expected.fieldName}`,
          );
          return (
            matches.length === 1 &&
            matches[0]?.querySelector(".file-upload__filename")?.textContent?.trim() ===
              expected.name &&
            [...(matches[0]?.querySelectorAll("button") ?? [])].some((button) =>
              /remove/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
            )
          );
        },
        { fieldName: upload.fieldName, name: upload.name },
      );
      if (!retained)
        throw new Error("Greenhouse staged attachment no longer matches its displayed file");
      this.fields.push({
        ...upload.field,
        ref: `${randomUUID()}-retained`,
        value: upload.name,
        fileHashes: [upload.sha256],
      });
    }
    const text = await this.page.locator("body").innerText();
    const submits = this.page
      .locator("form#application-form")
      .getByRole("button", { name: "Submit application", exact: true });
    return {
      url: this.page.url(),
      text,
      fields: this.fields,
      submitCount: await submits.count(),
      securityBlock: false,
      submitMethod: "POST",
      submitAction: this.identity.targetUrl,
    };
  }
  async fill(field: Field, value: string | boolean | string[]) {
    if (!this.page || !this.identity || !("adapter" in field) || field.adapter !== "greenhouse")
      throw new Error("Invalid Greenhouse field");
    await this.scope!.authorize();
    const mapped = this.identity?.choices[field.name]?.filter((choice) => choice.value === value);
    if (typeof value === "string")
      this.lookup = { name: field.name, value: mapped?.length === 1 ? mapped[0]!.label : value };
    try {
      await fillGreenhouseField(this.page, field as GreenhouseField, value, {
        phoneCountryDialCode: this.phoneCountryDialCode,
      });
      this.filled[field.name] = value;
      if (field.name === "location") {
        const selected = this.locations.filter((item) => item.label === value);
        if (selected.length !== 1) throw new Error("No source-grounded location coordinates");
        this.location = selected[0];
      }
      if (field.name === "country" && typeof value === "string") {
        const selected = (field as GreenhouseField).choices.filter(
          (item) => item.label === value || item.value === value,
        );
        if (selected.length === 1)
          this.phoneCountryDialCode = /\+(\d+)$/.exec(selected[0]!.label)?.[1];
      }
      const selected = await this.page
        .locator(`[data-jobpilot-ref="${field.ref}"]`)
        .evaluate((input) => {
          const shell = input.closest(".select-shell");
          return shell?.querySelector(".select__single-value")?.textContent?.trim();
        });
      if (selected) {
        const known = this.identity?.choices[field.name]?.filter(
          (choice) => choice.label === selected,
        );
        const choice =
          known?.length === 1
            ? known[0]
            : (field as GreenhouseField).choices.find((choice) => choice.label === selected);
        if (choice) this.selections[field.name] = choice;
      }
    } finally {
      this.lookup = undefined;
    }
  }
  async upload(field: Field, path: string, bytes: Buffer) {
    if (!this.page || !this.identity || !("adapter" in field) || field.adapter !== "greenhouse")
      throw new Error("Invalid Greenhouse upload field");
    await this.scope!.authorize();
    const existing = this.uploads.get(field.name);
    if (
      existing?.completed &&
      existing.sha256 === hash(bytes) &&
      existing.name === basename(path)
    ) {
      const observed = (await this.snapshot()).fields.find((item) => item.name === field.name);
      if (observed?.fileHashes?.[0] === existing.sha256) return;
    }
    const upload: Upload = {
      fieldName: field.name,
      name: basename(path),
      sha256: hash(bytes),
      completed: false,
      field: field as GreenhouseField,
    };
    this.uploads.set(field.name, upload);
    await uploadGreenhouseFile(this.page, field as GreenhouseField, {
      name: upload.name,
      mimeType: "application/pdf",
      buffer: bytes,
    });
    const deadline = Date.now() + 15_000;
    while (!upload.completed && Date.now() < deadline && !this.routeError)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!upload.completed)
      throw new Error(
        `Greenhouse attachment staging was not confirmed${this.routeError ? `: ${this.routeError}` : ""}`,
      );
    const renderDeadline = Date.now() + 5_000;
    let rendered = false;
    while (!rendered && Date.now() < renderDeadline && !this.routeError) {
      rendered = await finishGreenhouseUploadProgress(
        this.page,
        new URL(this.presigns[upload.fieldName]!.url).href,
        upload.transferredBytes!,
      );
      if (!rendered) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!rendered) throw new Error("Greenhouse upload completion was not observed by the browser");
    await this.page.waitForFunction(
      (expected) => {
        const groups = [...document.querySelectorAll("form#application-form .file-upload")].filter(
          (group) => group.getAttribute("aria-labelledby") === `upload-label-${expected.fieldName}`,
        );
        return (
          groups.length === 1 &&
          groups[0]?.querySelector(".file-upload__filename")?.textContent?.trim() ===
            expected.name &&
          [...(groups[0]?.querySelectorAll("button") ?? [])].some((button) =>
            /remove/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
          )
        );
      },
      { fieldName: upload.fieldName, name: upload.name },
      { timeout: Math.max(1, renderDeadline - Date.now()) },
    );
  }
  async submit() {
    if (!this.page || this.sent || !this.identity) throw new Error("Greenhouse cannot resubmit");
    this.armed = true;
    this.pendingResponse = new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
    try {
      await this.page
        .locator("form#application-form")
        .getByRole("button", { name: "Submit application", exact: true })
        .click({ timeout: 10_000 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.pendingResponse,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Greenhouse submit response unavailable")),
              20_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!this.receipt) throw new Error("Greenhouse submit has no correlated response");
      if (
        classifyGreenhouseResponse(this.receipt.responseStatus, this.receipt.responseBody).kind ===
        "accepted"
      )
        await this.page.waitForURL((url) => url.pathname === this.identity!.confirmationPath, {
          timeout: 10_000,
        });
    } finally {
      this.armed = false;
    }
  }
  async close() {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }
}
