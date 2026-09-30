/// <reference lib="dom" />
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import type { PersonalScreeningAnswer } from "../../../packages/contracts/src/personal-readiness";
import { saveBrokerDiagnostic } from "./diagnostics";

export interface BrokerConfig {
  api: string;
  token: string;
  attemptId: string;
  leaseOwner: string;
  leaseGeneration: number;
  root: string;
}
interface Answer {
  key: string;
  value: PersonalScreeningAnswer["value"];
  fieldName?: string;
  label?: string;
}
interface Attempt {
  id: string;
  userId: string;
  recordId: string;
  mode: "offline" | "live_preview" | "submit";
  state: string;
  manifestHash: string;
  manifest: {
    answers?: Answer[];
    document?: { path: string; sha256: string };
    attachments?: {
      path: string;
      sha256: string;
      fieldName: string;
      label: string;
      required: boolean;
    }[];
    applicantEmail?: string;
    canonicalUrl?: string;
    identity?: string;
  };
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
}
interface RecordDto {
  id: string;
  title: string;
  url: string;
  identity: string;
  requisitionId: string | null;
}
export interface Field {
  ref: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  value: string;
  checked?: boolean;
  fileHashes?: string[];
  options: string[];
  multiple?: boolean;
  selectedValues?: string[];
}
export interface Snapshot {
  url: string;
  text: string;
  fields: Field[];
  submitCount: number;
  securityBlock: boolean;
  confirmationText?: string;
  confirmationHeading?: boolean;
  submitAction?: string;
  submitMethod?: string;
}
export interface DriverScope {
  attemptId: string;
  manifestHash: string;
  identity: string;
  authorize(): Promise<void>;
  freeze(targetUrl: string, requestBody: string): Promise<void>;
}
export interface TransportReceipt {
  targetUrl: string;
  requestBodyHash: string;
  applicationPayloadHash: string;
  responseStatus: number;
  responseBody: string;
  capturedAt: string;
}
export interface BrowserDriver {
  configure?(scope: DriverScope): void;
  acceptsUrl?(url: string): boolean;
  submissionEvidence?(): TransportReceipt | undefined;
  confirmed?(): boolean;
  answerMatches?(field: Field, value: PersonalScreeningAnswer["value"]): boolean;
  open(url: string, profile: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  fill(field: Field, value: PersonalScreeningAnswer["value"]): Promise<void>;
  upload(field: Field, path: string, bytes: Buffer): Promise<void>;
  submit(): Promise<void>;
  close(): Promise<void>;
}
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  return value;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function clean(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function safeUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export class PlaywrightDriver implements BrowserDriver {
  private scope?: DriverScope;
  private transmitting = false;
  configure(scope: DriverScope) {
    this.scope = scope;
  }
  private context?: BrowserContext;
  private page?: Page;
  private origin = "";
  private blockedNavigation = false;
  private submissionTarget?: { url: string; method: string };
  private observedTarget?: { url: string; method: string };
  private observedFields: Field[] = [];
  private initialUrl = "";
  async open(url: string, profile: string) {
    const { chromium } = await import("@playwright/test");
    this.origin = new URL(url).origin;
    this.initialUrl = url;
    this.context = await chromium.launchPersistentContext(profile, {
      headless: true,
      timeout: 10_000,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== this.origin) {
        if (request.isNavigationRequest()) this.blockedNavigation = true;
        await route.abort("blockedbyclient");
        return;
      }
      if (request.isNavigationRequest()) {
        const target = new URL(request.url());
        const original = new URL(this.initialUrl);
        if (
          [...target.searchParams].some(([key, value]) => original.searchParams.get(key) !== value)
        ) {
          this.blockedNavigation = true;
          await route.abort("blockedbyclient");
          return;
        }
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        if (
          !this.submissionTarget ||
          request.url() !== this.submissionTarget.url ||
          request.method() !== this.submissionTarget.method
        ) {
          await route.abort("blockedbyclient");
          return;
        }
        this.submissionTarget = undefined;
        if (
          !(await this.matchesFinalPayload(
            request.postDataBuffer(),
            request.headers()["content-type"] ?? "",
          ))
        ) {
          await route.abort("blockedbyclient");
          return;
        }
      }
      try {
        if (this.transmitting) {
          if (!this.scope)
            throw new Error("Browser transmission requires an application authority");
          await this.scope.authorize();
        }
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10_000 });
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          if (request.isNavigationRequest()) this.blockedNavigation = true;
          await route.fulfill({
            status: 409,
            contentType: "text/plain",
            body: "Redirect blocked; user review required",
          });
          return;
        }
        await route.fulfill({ response });
      } catch {
        await route.abort("failed");
      }
    });
    await this.context.routeWebSocket("**/*", (socket) => socket.close());
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
  }
  async snapshot(): Promise<Snapshot> {
    if (!this.page) throw new Error("Browser is not open");
    if (this.blockedNavigation || new URL(this.page.url()).origin !== this.origin)
      throw new Error("needs_user: Navigation left the authorized source origin");
    const nonce = randomUUID();
    const snapshot = await this.page.evaluate(async (prefix) => {
      const elements = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,textarea,select",
        ),
      ].filter((element) => element.getBoundingClientRect().width > 0 && element.type !== "hidden");
      const fields = await Promise.all(
        elements.map(async (element, index) => {
          const ref = `${prefix}-${index}`;
          element.setAttribute("data-jobpilot-ref", ref);
          const label =
            [...(element.labels ?? [])].map((node) => node.textContent?.trim() ?? "").join(" ") ||
            element.getAttribute("aria-label") ||
            (element.getAttribute("aria-labelledby") ?? "")
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
              .filter(Boolean)
              .join(" ") ||
            "";
          const fileHashes =
            element instanceof HTMLInputElement && element.type === "file"
              ? await Promise.all(
                  Array.from(element.files ?? []).map(async (file) => {
                    if (file.size > 20_000_000) throw new Error("Observed file exceeds limit");
                    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
                    return Array.from(new Uint8Array(digest), (byte) =>
                      byte.toString(16).padStart(2, "0"),
                    ).join("");
                  }),
                )
              : undefined;
          return {
            ref,
            name: element.name,
            label,
            type:
              element instanceof HTMLTextAreaElement
                ? "textarea"
                : element instanceof HTMLSelectElement
                  ? "select"
                  : element.type,
            required: element.required,
            multiple: element instanceof HTMLSelectElement && element.multiple,
            selectedValues:
              element instanceof HTMLSelectElement && element.multiple
                ? [...element.selectedOptions].map((option) => option.value)
                : undefined,
            value: element.value,
            fileHashes,
            checked: element instanceof HTMLInputElement ? element.checked : undefined,
            options:
              element instanceof HTMLSelectElement
                ? [...element.options]
                    .filter((option) => !option.disabled)
                    .map((option) => option.value)
                : [],
          };
        }),
      );
      const text = document.body.innerText;
      const submits = [
        ...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          'button[type="submit"],input[type="submit"],button[type="button"]',
        ),
      ].filter((element) => {
        if (element.getBoundingClientRect().width <= 0) return false;
        const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        const label = (
          labelledBy ||
          element.getAttribute("aria-label") ||
          element.innerText ||
          element.value
        )
          .trim()
          .replace(/\s+/g, " ");
        if (/^(?:submit(?: (?:my )?application)?|apply(?: now)?|send application)$/i.test(label))
          return true;
        return (
          element.type === "submit" &&
          /submit (?:application|my application)|apply now/i.test(label)
        );
      });
      for (const element of document.querySelectorAll("[data-jobpilot-submit]"))
        element.removeAttribute("data-jobpilot-submit");
      for (const element of submits) element.setAttribute("data-jobpilot-submit", "true");
      const evidenceRoot = document.body.cloneNode(true) as HTMLElement;
      for (const element of evidenceRoot.querySelectorAll(
        "blockquote,q,pre,code,form,script,style,template",
      ))
        element.remove();
      const confirmationHeading = [...evidenceRoot.querySelectorAll("h1,h2,[role=status]")].some(
        (element) =>
          /^(?:your )?application (?:has been |was )?(?:submitted|received)[.!]?$|^thank you for applying[.!]?$/i.test(
            element.textContent?.trim() ?? "",
          ),
      );
      const finalControl = submits.length === 1 ? submits[0] : undefined;
      // Script-driven buttons have no verified native submission contract even inside a form.
      const form = finalControl?.type === "submit" ? finalControl.form : undefined;
      return {
        confirmationText: evidenceRoot.innerText || evidenceRoot.textContent || "",
        confirmationHeading,
        submitAction: form?.action,
        submitMethod: form?.method.toUpperCase(),
        url: location.href,
        text,
        fields,
        submitCount: submits.length,
        securityBlock:
          !!document.querySelector(
            'iframe[src*="captcha"],input[type="password"],iframe[src*="challenge"]',
          ) || /verify (?:you are|you're) human|security challenge|sign in to continue/i.test(text),
      };
    }, nonce);
    this.observedTarget =
      snapshot.submitAction && snapshot.submitMethod === "POST"
        ? { url: snapshot.submitAction, method: "POST" }
        : undefined;
    this.observedFields = snapshot.fields;
    return snapshot;
  }
  private async matchesFinalPayload(bytes: Buffer | null, contentType: string): Promise<boolean> {
    if (
      !bytes ||
      bytes.byteLength > 20_000_000 ||
      !/^(?:multipart\/form-data|application\/x-www-form-urlencoded)\b/i.test(contentType)
    )
      return false;
    try {
      const body = await new Response(new Uint8Array(bytes), {
        headers: { "content-type": contentType },
      }).formData();
      for (const field of this.observedFields) {
        if (!field.name || ["submit", "button", "reset"].includes(field.type)) continue;
        const values = body.getAll(field.name);
        if (field.type === "file") {
          const expected = field.fileHashes ?? [];
          const files = values.filter(
            (value): value is File => typeof value !== "string" && value.size > 0,
          );
          if (files.length !== expected.length) return false;
          for (let index = 0; index < files.length; index++)
            if (sha(new Uint8Array(await files[index]!.arrayBuffer())) !== expected[index])
              return false;
        } else if (field.type === "checkbox" && !field.checked) {
          if (values.length) return false;
        } else if (
          values.length !== 1 ||
          typeof values[0] !== "string" ||
          values[0] !== field.value
        )
          return false;
      }
      for (const key of body.keys())
        if (
          !this.observedFields.some((field) => field.name === key) &&
          !/^(?:csrf(?:_token)?|authenticity_token|utf8|commit)$/i.test(key)
        )
          return false;
      return true;
    } catch {
      return false;
    }
  }
  async fill(field: Field, value: PersonalScreeningAnswer["value"]) {
    if (!this.page) throw new Error("Browser is not open");
    this.transmitting = true;
    const locator = this.page.locator(`[data-jobpilot-ref="${field.ref}"]`);
    if (field.type === "checkbox") {
      if (typeof value !== "boolean")
        throw new Error("needs_user: Checkbox needs an explicit boolean answer");
      await locator.setChecked(value);
    } else if (field.type === "select" && field.multiple) {
      if (
        !Array.isArray(value) ||
        value.some((item) => field.options.filter((option) => option === item).length !== 1)
      )
        throw new Error("needs_user: Answer does not match observed multiselect options");
      const prior = await locator.evaluate((element) => {
        if (!(element instanceof HTMLSelectElement) || !element.multiple)
          throw new Error("needs_user: Multiselect control changed");
        return [...element.selectedOptions].map((option) => option.value);
      });
      if (
        prior.length &&
        (prior.length !== value.length || !value.every((item) => prior.includes(item)))
      )
        throw new Error("needs_user: Existing selections conflict with the approved answer");
      await locator.selectOption(value);
    } else if (field.type === "select") {
      if (
        typeof value !== "string" ||
        field.options.filter((option) => option === value).length !== 1
      )
        throw new Error("needs_user: Answer does not match observed select option");
      await locator.selectOption(value);
    } else {
      if (typeof value !== "string") throw new Error("needs_user: Text field needs explicit text");
      await locator.fill(value);
    }
  }
  async upload(field: Field, path: string, bytes: Buffer) {
    if (!this.page) throw new Error("Browser is not open");
    this.transmitting = true;
    await this.page
      .locator(`[data-jobpilot-ref="${field.ref}"]`)
      .setInputFiles({ name: basename(path), mimeType: "application/pdf", buffer: bytes });
  }
  async submit() {
    if (!this.observedTarget || new URL(this.observedTarget.url).origin !== this.origin)
      throw new Error("needs_user: No supported same-origin POST form");
    this.submissionTarget = this.observedTarget;
    if (!this.page) throw new Error("Browser is not open");
    try {
      await this.page.locator('[data-jobpilot-submit="true"]').click({ timeout: 10_000 });
      await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await this.page.waitForTimeout(500);
    } finally {
      this.submissionTarget = undefined;
    }
  }
  async close() {
    await this.context?.close();
  }
}

export class PersonalBrowserBroker {
  private attempt?: Attempt;
  private record?: RecordDto;
  private snapshot?: Snapshot;
  private lockPath?: string;
  private opened = false;
  private driverClosed = false;
  private crossedBoundary = false;
  private used = new Map<string, PersonalScreeningAnswer["value"]>();
  private uploadedHash?: string;
  private uploadedFields = new Map<string, string>();
  private lockNonce = randomUUID();
  constructor(
    private readonly config: BrokerConfig,
    private driver: BrowserDriver | undefined = undefined,
    private readonly request: typeof fetch = fetch,
  ) {
    const api = new URL(config.api);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
      !["http:", "https:"].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.pathname !== "/" ||
      api.search ||
      api.hash
    )
      throw new Error("Broker API must be a fixed loopback origin");
    if (
      !uuid.test(config.attemptId) ||
      !config.token ||
      !config.leaseOwner ||
      !Number.isInteger(config.leaseGeneration) ||
      config.leaseGeneration < 1 ||
      !isAbsolute(config.root)
    )
      throw new Error("Invalid scoped broker configuration");
  }
  private async api(path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(
      `${this.config.api.replace(/\/$/, "")}/api/personal${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`API refused action (${response.status}); needs_user`);
    return response.json();
  }
  private lease() {
    return { leaseOwner: this.config.leaseOwner, leaseGeneration: this.config.leaseGeneration };
  }
  private async load() {
    const attempt = (await this.api(`/attempts/${this.config.attemptId}`)) as Attempt;
    if (
      attempt.id !== this.config.attemptId ||
      !uuid.test(attempt.userId) ||
      !uuid.test(attempt.recordId) ||
      !["offline", "live_preview", "submit"].includes(attempt.mode)
    )
      throw new Error("Invalid attempt scope");
    if (attempt.manifestHash !== sha(JSON.stringify(sorted(attempt.manifest))))
      throw new Error("Manifest integrity mismatch");
    if (this.attempt && this.attempt.manifestHash !== attempt.manifestHash)
      throw new Error("Immutable manifest changed");
    this.attempt = attempt;
    const record = (await this.api(`/${attempt.recordId}`)) as RecordDto;
    if (record.id !== attempt.recordId) throw new Error("Record identity mismatch");
    const url = new URL(record.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid job URL");
    if (
      attempt.manifest.canonicalUrl &&
      ((new URL(attempt.manifest.canonicalUrl).origin !== url.origin &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          new URL(attempt.manifest.canonicalUrl).host === url.host
        )) ||
        new URL(attempt.manifest.canonicalUrl).pathname.replace(/\/$/, "") !==
          url.pathname.replace(/\/$/, ""))
    )
      throw new Error("Frozen job URL changed");
    if (attempt.manifest.identity && attempt.manifest.identity !== record.identity)
      throw new Error("Frozen requisition identity changed");
    if (this.record && this.record.url !== record.url) throw new Error("Captured job URL changed");
    this.record = record;
    return attempt;
  }
  private validateLease(attempt: Attempt) {
    if (
      attempt.leaseOwner !== this.config.leaseOwner ||
      attempt.leaseGeneration !== this.config.leaseGeneration ||
      !Number.isFinite(Date.parse(attempt.leaseExpiresAt)) ||
      Date.parse(attempt.leaseExpiresAt) <= Date.now()
    )
      throw new Error("needs_user: Lease expired or ownership changed");
  }
  private async open(preparation = false) {
    const attempt = await this.load();
    if (preparation) this.requirePreparation(attempt);
    if (attempt.mode === "offline")
      throw new Error("offline: Browser and employer requests are disabled");
    this.validateLease(attempt);
    if (!this.opened) {
      const userDirectory = join(this.config.root, "users", attempt.userId);
      await mkdir(userDirectory, { recursive: true, mode: 0o700 });
      await chmod(userDirectory, 0o700);
      this.lockPath = join(userDirectory, "browser.lock");
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
      } catch {
        this.lockPath = undefined;
        throw new Error(
          "needs_user: Exclusive browser profile is already in use; stale locks require manual review",
        );
      }
      await writeFile(
        join(this.lockPath, "owner.json"),
        JSON.stringify({
          attemptId: attempt.id,
          leaseOwner: this.config.leaseOwner,
          pid: process.pid,
          nonce: this.lockNonce,
        }),
        { mode: 0o600 },
      );
      const profile = join(userDirectory, "browser-profile");
      if (!this.driver) {
        const { GreenhouseDriver, isGreenhousePosting } = await import("./greenhouse-driver");
        if (isGreenhousePosting(this.record?.url ?? "", this.record?.identity ?? ""))
          this.driver = new GreenhouseDriver();
        else if (this.record?.identity.startsWith("lever:")) {
          const { LeverDriver } = await import("./lever-driver");
          this.driver = new LeverDriver();
        } else this.driver = new PlaywrightDriver();
      }
      this.driver.configure?.({
        attemptId: attempt.id,
        manifestHash: attempt.manifestHash,
        identity: this.record?.identity ?? "",
        authorize: async () => {
          const current = await this.load();
          this.validateLease(current);
          await this.api(`/attempts/${current.id}/authorize-transmission`, this.lease());
          if (!["preparing", "prepared", "submitting"].includes(current.state))
            throw new Error("Browser authority was revoked");
        },
        freeze: async (targetUrl, requestBody) => {
          const lever = this.record?.identity.startsWith("lever:");
          const evidenceHash = await this.privateChallengeArtifact({
            schemaVersion: 1,
            kind: lever ? "lever_submission_payload" : "greenhouse_submission_payload",
            attemptId: attempt.id,
            manifestHash: attempt.manifestHash,
            targetUrl,
            requestBody,
            capturedAt: new Date().toISOString(),
          });
          await this.api(
            `/attempts/${attempt.id}/${lever ? "hosted-transport" : "challenge"}/freeze`,
            {
              ...this.lease(),
              evidenceHash,
            },
          );
        },
      });
      try {
        this.driverClosed = false;
        await this.driver.open(this.record?.url ?? "", profile);
      } catch (error) {
        await this.close().catch(() => undefined);
        throw error;
      }
      this.snapshot = undefined;
      this.used.clear();
      this.uploadedHash = undefined;
      this.uploadedFields.clear();
      this.opened = true;
    }
    return attempt;
  }
  private async privateChallengeArtifact(artifact: unknown) {
    if (!this.attempt) throw new Error("Attempt missing");
    const directory = join(this.config.root, "storage", this.attempt.userId, "challenges");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(artifact, null, 2);
    const digest = sha(bytes);
    await writeFile(join(directory, `${digest}.json`), bytes, { mode: 0o600, flag: "wx" });
    return digest;
  }
  private matchesSource(url: string) {
    return (
      !!this.record &&
      (this.driver?.acceptsUrl?.(url) ?? new URL(url).origin === new URL(this.record.url).origin)
    );
  }
  private requirePreparation(attempt: Attempt) {
    if (!["preparing", "prepared"].includes(attempt.state) || this.crossedBoundary)
      throw new Error("needs_user: Preparation authority was cancelled or is no longer active");
  }
  private async checkSnapshot(snapshot: Snapshot) {
    if (!this.matchesSource(snapshot.url))
      throw new Error("needs_user: Page left the authorized origin");
    if (snapshot.securityBlock) {
      if (
        !this.crossedBoundary &&
        this.attempt &&
        ["preparing", "prepared"].includes(this.attempt.state)
      ) {
        const reason = /captcha|verify (?:you are|you're) human/i.test(snapshot.text)
          ? "captcha"
          : "login";
        await this.api(`/attempts/${this.attempt.id}/handoff/request`, { ...this.lease(), reason });
        await this.close();
      }
      throw new Error("needs_user: Login, CAPTCHA or security challenge requires user handling");
    }
  }
  async inspectForm() {
    const attempt = await this.open(true);
    this.snapshot = await this.driver!.snapshot();
    if (this.snapshot.submitCount > 0 && this.snapshot.submitMethod !== "POST") {
      await this.api(`/attempts/${attempt.id}/park`, {
        ...this.lease(),
        kind: "blocked",
        reason:
          "Unsupported employer form: a verified portal adapter is required before application preparation. A login or CAPTCHA handoff cannot resolve this integration gap.",
      });
      await this.close();
      throw new Error("needs_user: Unsupported employer form; portal adapter required");
    }
    await this.checkSnapshot(this.snapshot);
    // Applicant values and untrusted page content never cross the model boundary.
    // Persist questions privately so a user can supply exact answers later.
    const directory = join(this.config.root, "storage", attempt.userId, "inspections");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const inspectionBytes = JSON.stringify(
      {
        attemptId: attempt.id,
        observedAt: new Date().toISOString(),
        fields: this.snapshot.fields.map(
          ({ value: _value, selectedValues: _selected, ...field }) => field,
        ),
      },
      null,
      2,
    );
    await writeFile(join(directory, `${sha(inspectionBytes)}.json`), inspectionBytes, {
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const latest = join(directory, `${attempt.id}.${randomUUID()}.tmp`);
    await writeFile(latest, inspectionBytes, { mode: 0o600 });
    await rename(latest, join(directory, `${attempt.id}.json`));
    return {
      mode: attempt.mode,
      transmitting: true,
      privacyScope: "metadata_only",
      fields: this.snapshot.fields.map((field) => {
        const matches = (attempt.manifest.answers ?? []).flatMap((answer, index) =>
          this.answerTargetsField(answer, field, this.snapshot!.fields) ? [`answer-${index}`] : [],
        );
        const attachments = (attempt.manifest.attachments ?? []).flatMap((attachment, index) =>
          field.type === "file" && attachment.fieldName === field.name
            ? [`attachment-${index}`]
            : [],
        );
        return {
          ref: field.ref,
          type: field.type,
          required: field.required,
          hasValue: field.multiple ? !!field.selectedValues?.length : !!field.value,
          resumeUpload:
            field.type === "file" && /resume|résumé|cv/i.test(`${field.name} ${field.label}`),
          answerKey: matches.length === 1 ? matches[0] : null,
          attachmentKey: attachments.length === 1 ? attachments[0] : null,
          needsAnswer: field.required && field.type !== "file" && matches.length !== 1,
        };
      }),
      submitCount: this.snapshot.submitCount,
    };
  }

  private answerTargetsField(answer: Answer, field: Field, fields: Field[]) {
    if (answer.fieldName)
      return (
        answer.fieldName === field.name &&
        fields.filter((entry) => entry.name === field.name).length === 1
      );
    return (
      !!answer.label &&
      clean(answer.label) === clean(field.label) &&
      fields.filter((entry) => clean(entry.label) === clean(field.label)).length === 1
    );
  }
  private answerMatches(field: Field, value: PersonalScreeningAnswer["value"]) {
    if (Array.isArray(value))
      return (
        !!field.multiple &&
        Array.isArray(field.selectedValues) &&
        field.selectedValues.length === value.length &&
        new Set(field.selectedValues).size === value.length &&
        value.every((item) => field.selectedValues!.includes(item))
      );
    return (
      this.driver?.answerMatches?.(field, value) ??
      (field.type === "checkbox" ? field.checked === value : field.value === value)
    );
  }
  private async observedField(expected: Field) {
    const current = await this.driver!.snapshot();
    await this.checkSnapshot(current);
    const matches = current.fields.filter(
      (field) =>
        field.name === expected.name &&
        field.label === expected.label &&
        field.type === expected.type,
    );
    if (matches.length !== 1)
      throw new Error("needs_user: Field identity changed or became ambiguous");
    return matches[0]!;
  }
  private async authorizeTransmission(attempt: Attempt) {
    await this.api(`/attempts/${attempt.id}/authorize-transmission`, this.lease());
  }

  async fillField(ref: string, answerKey: string) {
    const attempt = await this.open(true);
    const field = this.snapshot?.fields.find((entry) => entry.ref === ref);
    const index = /^answer-\d+$/.test(answerKey) ? Number(answerKey.slice(7)) : -1;
    const answers =
      index >= 0 && attempt.manifest.answers?.[index] ? [attempt.manifest.answers[index]] : [];
    if (!field || answers.length !== 1)
      throw new Error("needs_user: Field or immutable answer is unknown");
    const answer = answers[0];
    if (
      !answer ||
      !["text", "email", "tel", "url", "number", "date", "textarea", "select", "checkbox"].includes(
        field.type,
      )
    )
      throw new Error("needs_user: Unsupported field");
    const duplicate = this.snapshot?.fields.filter(
      (entry) => entry.name === field.name && entry.label === field.label,
    );
    if (duplicate?.length !== 1) throw new Error("needs_user: Ambiguous field identity");
    if (!this.answerTargetsField(answer, field, this.snapshot!.fields))
      throw new Error("needs_user: Answer does not match observed field identity");
    const observed = await this.observedField(field);
    if (Boolean(observed.multiple) !== Boolean(field.multiple))
      throw new Error("needs_user: Field selection mode changed");
    if (observed.multiple) {
      if (
        !Array.isArray(answer.value) ||
        answer.value.length > 50 ||
        new Set(answer.value).size !== answer.value.length ||
        answer.value.some(
          (item) =>
            !item.trim() || observed.options.filter((option) => option === item).length !== 1,
        )
      )
        throw new Error(
          "needs_user: Multiple selections require a complete exact approved option set",
        );
      if (!Array.isArray(observed.selectedValues))
        throw new Error("needs_user: Existing selections could not be verified");
      if (observed.selectedValues.length && !this.answerMatches(observed, answer.value))
        throw new Error("needs_user: Existing selections conflict with the approved answer");
    } else if (Array.isArray(answer.value))
      throw new Error("needs_user: An answer set requires an observed multiselect control");
    if (
      observed.type === "date" &&
      (typeof answer.value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(answer.value))
    )
      throw new Error("needs_user: Date control requires an exact approved calendar date");
    if (
      !observed.multiple &&
      observed.type !== "checkbox" &&
      observed.value &&
      !this.answerMatches(observed, answer.value)
    )
      throw new Error("needs_user: Existing field value conflicts with the approved answer");
    if (observed.type === "checkbox" && observed.checked === true && answer.value !== true)
      throw new Error("needs_user: Existing checkbox value conflicts with the approved answer");
    await this.authorizeTransmission(attempt);
    await this.driver!.fill(observed, answer.value);
    const filled = await this.observedField(observed);
    if (!this.answerMatches(filled, answer.value))
      throw new Error("needs_user: Approved answer was not confirmed after filling");
    this.used.set(field.name || field.label, answer.value);
    return { status: "filled", transmitting: true, ref, answerKey };
  }
  async uploadResume(ref: string) {
    const attempt = await this.open(true);
    const field = this.snapshot?.fields.find((entry) => entry.ref === ref);
    if (field?.type !== "file" || !/resume|résumé|cv/i.test(`${field.name} ${field.label}`))
      throw new Error("needs_user: Unique observed resume upload field required");
    if (
      this.snapshot?.fields.filter(
        (entry) => entry.name === field.name && entry.label === field.label,
      ).length !== 1
    )
      throw new Error("needs_user: Ambiguous upload field");
    const artifact = attempt.manifest.document;
    if (!artifact) throw new Error("needs_user: No immutable document in manifest");
    const root = await realpath(this.config.root);
    const path = await realpath(artifact.path);
    if (relative(root, path).startsWith("..") || isAbsolute(relative(root, path)))
      throw new Error("Artifact lies outside the private runtime");
    const bytes = await readFile(path);
    if (sha(bytes) !== artifact.sha256) throw new Error("Resume artifact hash mismatch");
    const observed = await this.observedField(field);
    if (
      observed.fileHashes?.length &&
      (observed.fileHashes.length !== 1 || observed.fileHashes[0] !== artifact.sha256)
    )
      throw new Error("needs_user: Existing upload conflicts with the approved resume");
    await this.authorizeTransmission(attempt);
    await this.driver!.upload(observed, path, bytes);
    const uploaded = await this.observedField(observed);
    if (uploaded.fileHashes?.length !== 1 || uploaded.fileHashes[0] !== artifact.sha256)
      throw new Error("needs_user: Approved resume upload was not confirmed");
    this.uploadedHash = artifact.sha256;
    this.uploadedFields.set(field.name || field.label, artifact.sha256);
    return { status: "uploaded", transmitting: true, sha256: artifact.sha256 };
  }
  async uploadAttachment(ref: string, attachmentKey: string) {
    const attempt = await this.open(true);
    const field = this.snapshot?.fields.find((entry) => entry.ref === ref);
    const index = /^attachment-\d+$/.test(attachmentKey) ? Number(attachmentKey.slice(11)) : -1;
    const attachment = index >= 0 ? attempt.manifest.attachments?.[index] : undefined;
    if (
      field?.type !== "file" ||
      !attachment ||
      attachment.fieldName !== field.name ||
      this.snapshot?.fields.filter((entry) => entry.name === field.name).length !== 1
    )
      throw new Error("needs_user: Attachment does not match a unique observed field");
    const root = await realpath(join(this.config.root, "storage", attempt.userId));
    const path = await realpath(attachment.path);
    const inside = relative(root, path);
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Attachment lies outside private user storage");
    const bytes = await readFile(path);
    if (sha(bytes) !== attachment.sha256) throw new Error("Attachment artifact hash mismatch");
    const observed = await this.observedField(field);
    if (
      observed.fileHashes?.length &&
      (observed.fileHashes.length !== 1 || observed.fileHashes[0] !== attachment.sha256)
    )
      throw new Error("needs_user: Existing upload conflicts with the approved attachment");
    await this.authorizeTransmission(attempt);
    await this.driver!.upload(observed, path, bytes);
    const uploaded = await this.observedField(observed);
    if (uploaded.fileHashes?.length !== 1 || uploaded.fileHashes[0] !== attachment.sha256)
      throw new Error("needs_user: Approved attachment upload was not confirmed");
    this.uploadedFields.set(field.name || field.label, attachment.sha256);
    return { status: "uploaded", transmitting: true, attachmentKey };
  }
  private expectedEmail() {
    return (
      this.attempt?.manifest.applicantEmail ??
      this.attempt?.manifest.answers?.find(
        (answer) =>
          typeof answer.value === "string" && /email/i.test(`${answer.fieldName} ${answer.label}`),
      )?.value
    );
  }
  private async evidence(
    outcome: "submitted" | "uncertain",
    snapshot: Snapshot | undefined,
    details: string,
  ) {
    if (!this.attempt || !this.record) throw new Error("Attempt missing");
    const capturedAt = new Date().toISOString();
    const artifact = {
      capturedAt,
      attemptId: this.attempt.id,
      manifestHash: this.attempt.manifestHash,
      originalUrl: this.record.url,
      sourceUrl: snapshot?.url ?? this.record.url,
      requisitionId: this.record.requisitionId,
      title: this.record.title,
      expectedApplicantEmail: this.expectedEmail(),
      observedText: snapshot?.text ?? "",
      outcome,
      details,
      transport: this.driver?.submissionEvidence?.(),
    };
    const bytes = JSON.stringify(artifact, null, 2);
    const hash = sha(bytes);
    const directory = join(this.config.root, "storage", this.attempt.userId, "receipts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifactPath = join(directory, `${hash}.json`);
    await writeFile(artifactPath, bytes, { mode: 0o600, flag: "wx" });
    return {
      outcome,
      kind: outcome === "submitted" ? "confirmation_page" : "manual_review",
      artifactPath,
      sha256: hash,
      sourceUrl: safeUrl(artifact.sourceUrl),
      capturedAt,
      details,
      manifestHash: this.attempt.manifestHash,
      ...(this.record.requisitionId ? { externalReference: this.record.requisitionId } : {}),
    };
  }
  private confirms(snapshot: Snapshot) {
    if (this.driver?.confirmed) return this.driver.confirmed();
    const email = this.expectedEmail();
    return (
      !!this.record &&
      typeof email === "string" &&
      snapshot.confirmationHeading === true &&
      clean(snapshot.confirmationText ?? "").includes(clean(email)) &&
      clean(snapshot.confirmationText ?? "").includes(clean(this.record.title)) &&
      new URL(snapshot.url).origin === new URL(this.record.url).origin
    );
  }
  async submitApplication() {
    if (this.crossedBoundary) throw new Error("submission_uncertain: Submission cannot be retried");
    const attempt = await this.open(true);
    if (attempt.mode !== "submit") throw new Error("live_preview: Final submission is prohibited");
    if (this.crossedBoundary || !["preparing", "prepared"].includes(attempt.state))
      throw new Error("submission_uncertain: Submission cannot be retried");
    const snapshot = await this.driver!.snapshot();
    await this.checkSnapshot(snapshot);
    if (
      !this.record ||
      !clean(snapshot.text).includes(clean(this.record.title)) ||
      snapshot.submitCount !== 1 ||
      snapshot.submitMethod !== "POST" ||
      !snapshot.submitAction ||
      !this.matchesSource(snapshot.submitAction)
    )
      throw new Error("needs_user: Job identity or final submit control is ambiguous");
    const email = this.expectedEmail();
    if (
      typeof email !== "string" ||
      !snapshot.fields.some(
        (field) => (field.type === "email" || field.name === "email") && field.value === email,
      )
    )
      throw new Error("needs_user: Original applicant account identity is unverified");
    if (this.uploadedHash !== attempt.manifest.document?.sha256)
      throw new Error("needs_user: Manifest resume was not uploaded");
    for (const [name, fileHash] of this.uploadedFields) {
      const matching = snapshot.fields.filter(
        (field) => (field.name || field.label) === name && field.type === "file",
      );
      if (
        matching.length !== 1 ||
        matching[0]?.fileHashes?.length !== 1 ||
        matching[0]?.fileHashes?.[0] !== fileHash
      )
        throw new Error("needs_user: Observed attachment changed after upload");
    }
    for (const attachment of attempt.manifest.attachments ?? [])
      if (
        attachment.required &&
        this.uploadedFields.get(attachment.fieldName) !== attachment.sha256
      )
        throw new Error("needs_user: A required frozen attachment was not uploaded");
    for (const field of snapshot.fields) {
      const value = this.used.get(field.name || field.label);
      if (value !== undefined && !this.answerMatches(field, value))
        throw new Error("needs_user: Observed answer changed after fill");
    }
    for (const field of snapshot.fields) {
      if (field.required && field.type !== "file" && !this.used.has(field.name || field.label))
        throw new Error("needs_user: Required field lacks a supplied answer");
      if (field.required && field.type === "checkbox" && field.checked !== true)
        throw new Error("needs_user: Required checkbox has not been affirmatively answered");
      if (
        field.required &&
        field.type === "file" &&
        !this.uploadedFields.has(field.name || field.label)
      )
        throw new Error("needs_user: Required file field lacks a frozen attachment");
    }
    if (attempt.state === "preparing")
      await this.api(`/attempts/${attempt.id}/prepare`, this.lease());
    await this.api(`/attempts/${attempt.id}/begin-submit`, this.lease());
    this.crossedBoundary = true;
    try {
      await this.driver!.submit();
      const transport = this.driver?.submissionEvidence?.();
      if (transport && this.record?.identity.startsWith("greenhouse:")) {
        const { classifyGreenhouseResponse } = await import("./greenhouse-network");
        const result = classifyGreenhouseResponse(transport.responseStatus, transport.responseBody);
        if (result.kind === "challenge") {
          const evidenceHash = await this.privateChallengeArtifact({
            schemaVersion: 1,
            kind: "greenhouse_post_submit_challenge",
            attemptId: attempt.id,
            manifestHash: attempt.manifestHash,
            ...transport,
          });
          await this.api(`/attempts/${attempt.id}/challenge`, { ...this.lease(), evidenceHash });
          return {
            status: "submission_uncertain",
            needsUser: "Email or browser verification required; continue this same attempt",
            receiptHash: evidenceHash,
          };
        }
      }
      const confirmation = await this.driver!.snapshot();
      await this.checkSnapshot(confirmation);
      const outcome = this.confirms(confirmation) ? "submitted" : "uncertain";
      const evidence = await this.evidence(
        outcome,
        confirmation,
        outcome === "submitted"
          ? "Observed application confirmation matches original title and applicant email"
          : "No complete employer confirmation matched job and applicant identity; do not retry",
      );
      await this.api(`/attempts/${attempt.id}/receipt`, { ...this.lease(), evidence });
      return {
        status: outcome === "submitted" ? "submitted" : "submission_uncertain",
        receiptHash: evidence.sha256,
      };
    } catch {
      const evidence = await this.evidence(
        "uncertain",
        undefined,
        "Browser or receipt failure after submit boundary; do not retry",
      );
      try {
        await this.api(`/attempts/${attempt.id}/receipt`, { ...this.lease(), evidence });
      } catch {
        /* Persisted submitting lease expires to uncertain if the API is unavailable. */
      }
      return { status: "submission_uncertain", receiptHash: evidence.sha256 };
    }
  }
  async reconcile() {
    const attempt = await this.load();
    if (!["submitting", "submission_uncertain"].includes(attempt.state))
      return { status: attempt.state };
    if (!this.opened)
      return {
        status: "submission_uncertain",
        needsUser: "No observed confirmation is available; reopen manually without resubmitting",
      };
    const snapshot = await this.driver!.snapshot();
    await this.checkSnapshot(snapshot);
    if (!this.confirms(snapshot))
      return {
        status: "submission_uncertain",
        needsUser: "Observed page does not prove submission",
      };
    const evidence = await this.evidence(
      "submitted",
      snapshot,
      "Observed confirmation matches original job and applicant identity",
    );
    await this.api(`/attempts/${attempt.id}/reconcile`, { evidence });
    return { status: "submitted", receiptHash: evidence.sha256 };
  }
  async call(name: string, args: unknown) {
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Unauthorized payload; tool arguments must be an object");
    const input = object(args);
    if (name === "inspect_form" && Object.keys(input).length === 0) return this.inspectForm();
    if (
      name === "fill_field" &&
      Object.keys(input).every((key) => ["ref", "answerKey"].includes(key)) &&
      typeof input.ref === "string" &&
      typeof input.answerKey === "string"
    )
      return this.fillField(input.ref, input.answerKey);
    if (
      name === "upload_resume" &&
      Object.keys(input).length === 1 &&
      typeof input.ref === "string"
    )
      return this.uploadResume(input.ref);
    if (name === "submit_application" && Object.keys(input).length === 0)
      return this.submitApplication();
    if (
      name === "upload_attachment" &&
      Object.keys(input).length === 2 &&
      typeof input.ref === "string" &&
      typeof input.attachmentKey === "string"
    )
      return this.uploadAttachment(input.ref, input.attachmentKey);
    if (name === "reconcile" && Object.keys(input).length === 0) return this.reconcile();
    throw new Error("Unknown tool or unauthorized payload");
  }
  async diagnose(operation: string, error: unknown) {
    const manifest = this.attempt?.manifest;
    await saveBrokerDiagnostic(this.config, operation, error, [
      ...(manifest?.answers ?? []).flatMap((answer) => {
        if (Array.isArray(answer.value)) return answer.value;
        if (typeof answer.value === "string") return [answer.value];
        return [];
      }),
      manifest?.applicantEmail ?? "",
      manifest?.document?.path ?? "",
      ...(manifest?.attachments ?? []).map((artifact) => artifact.path),
    ]);
  }
  async close() {
    if (!this.driverClosed) {
      await this.driver?.close();
      this.driverClosed = true;
    }
    if (this.lockPath) {
      const owner = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as {
        nonce?: string;
      };
      if (owner.nonce === this.lockNonce) await rm(this.lockPath, { recursive: true });
    }
    this.lockPath = undefined;
    this.opened = false;
  }
}

export function brokerErrorForModel(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("offline:")) return "offline: Browser access disabled";
  if (message.startsWith("live_preview:")) return "live_preview: Final submission prohibited";
  if (message.startsWith("submission_uncertain:"))
    return "submission_uncertain: Reconcile before retrying";
  return "needs_user: Scoped action could not complete; inspect the private dashboard";
}
