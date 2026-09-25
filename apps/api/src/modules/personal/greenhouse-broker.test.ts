import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserDriver,
  type DriverScope,
  type Field,
  PersonalBrowserBroker,
  type Snapshot,
  type TransportReceipt,
} from "../../../../../plugin/scripts/personal-browser/core";
import { manifestHash } from "./persistence-policy";
import { describe, expect, test } from "bun:test";

const id = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const email = "synthetic-private@example.test";
const canary = "SYNTHETIC_PRIVATE_SCREENING_9258";
const posting = "https://job-boards.greenhouse.io/synthetic/jobs/123";
const target = "https://boards.greenhouse.io/synthetic/jobs/123";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

class HostedFake implements BrowserDriver {
  scope?: DriverScope;
  transport?: TransportReceipt;
  fields: Field[] = [
    {
      ref: "opaque-email",
      name: "email",
      label: `Email ${canary}`,
      type: "email",
      required: true,
      value: "",
      options: [canary],
    },
    {
      ref: "opaque-resume",
      name: "resume",
      label: `Resume ${canary}`,
      type: "file",
      required: true,
      value: "",
      options: [],
    },
  ];
  constructor(
    readonly events: string[],
    readonly challenge: boolean,
  ) {}
  configure(scope: DriverScope) {
    this.scope = scope;
    this.events.push("driver:configure");
  }
  acceptsUrl(url: string) {
    return [posting, target, `${posting}/confirmation`].includes(url);
  }
  async open() {
    this.events.push("driver:open");
  }
  async snapshot(): Promise<Snapshot> {
    return {
      url: this.confirmed() ? `${posting}/confirmation` : posting,
      text: `Synthetic Analyst ${email} ${canary}`,
      fields: this.confirmed() ? [] : this.fields,
      submitCount: this.confirmed() ? 0 : 1,
      securityBlock: false,
      submitMethod: "POST",
      submitAction: target,
    };
  }
  async fill(field: Field, value: string | boolean) {
    this.events.push("driver:fill");
    if (field.type === "checkbox") {
      if (typeof value !== "boolean") throw new Error("Synthetic checkbox requires a boolean");
      field.checked = value;
      field.value = "on";
      return;
    }
    field.value = String(value);
  }
  async upload(field: Field, _path: string, bytes: Buffer) {
    this.events.push("driver:upload");
    field.fileHashes = [hash(bytes)];
    field.value = "synthetic.pdf";
  }
  async submit() {
    if (!this.scope) throw new Error("Fake requires the broker scope contract");
    const consent = this.fields.find(
      (field) => field.name === "gdpr_demographic_data_consent_given",
    );
    const application = {
      email,
      ...(consent
        ? { data_compliance: { gdpr_demographic_data_consent_given: consent.checked } }
        : {}),
    };
    const requestBody = JSON.stringify({
      job_application: application,
      fingerprint: "synthetic-fingerprint",
      "g-recaptcha-enterprise-token": "synthetic-token",
    });
    await this.scope.authorize();
    await this.scope.freeze(target, requestBody);
    this.events.push("driver:employer-post");
    this.transport = {
      targetUrl: target,
      requestBodyHash: hash(requestBody),
      applicationPayloadHash: manifestHash(application),
      responseStatus: this.challenge ? 422 : 200,
      responseBody: this.challenge
        ? JSON.stringify({
            code: "captcha-failed",
            security_code_recipient: email,
            message: canary,
          })
        : "{}",
      capturedAt: new Date().toISOString(),
    };
  }
  submissionEvidence() {
    return this.transport;
  }
  confirmed() {
    return !!this.transport && this.transport.responseStatus === 200;
  }
  async close() {
    this.events.push("driver:close");
  }
}

async function fixture(
  mode: "offline" | "live_preview" | "submit",
  options: {
    challenge?: boolean;
    rejectFreeze?: boolean;
    requiredConsent?: boolean;
    consentAnswer?: boolean;
    startPrepared?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "greenhouse-broker-test-"));
  const userRoot = join(root, "storage", userId);
  await mkdir(userRoot, { recursive: true });
  const document = join(userRoot, "resume.pdf");
  await writeFile(document, "%PDF-synthetic-only", { mode: 0o600 });
  const events: string[] = [];
  const failures: string[] = [];
  const driver = new HostedFake(events, options.challenge === true);
  if (options.requiredConsent)
    driver.fields.push({
      ref: "opaque-consent",
      name: "gdpr_demographic_data_consent_given",
      label: "Synthetic required demographic data consent",
      type: "checkbox",
      required: true,
      value: "on",
      checked: false,
      options: [],
    });
  const answers: { key: string; fieldName: string; value: string | boolean }[] = [
    { key: "email", fieldName: "email", value: email },
  ];
  if (options.consentAnswer !== undefined)
    answers.push({
      key: "consent",
      fieldName: "gdpr_demographic_data_consent_given",
      value: options.consentAnswer,
    });
  const manifest = {
    identity: "greenhouse:synthetic:123",
    canonicalUrl: posting,
    applicantEmail: email,
    document: { path: document, sha256: hash("%PDF-synthetic-only") },
    answers,
  };
  let state = options.startPrepared ? "prepared" : "preparing";
  let generation = 1;
  let frozen: Record<string, unknown> | undefined;
  let challenge: Record<string, unknown> | undefined;
  let receipt: Record<string, unknown> | undefined;
  async function checkedArtifact(evidenceHash: string, kind: string) {
    const bytes = await readFile(join(userRoot, "challenges", `${evidenceHash}.json`), "utf8");
    if (hash(bytes) !== evidenceHash) throw new Error("Private artifact hash mismatch");
    const artifact = JSON.parse(bytes);
    if (
      artifact.kind !== kind ||
      artifact.attemptId !== id ||
      artifact.manifestHash !== manifestHash(manifest) ||
      artifact.targetUrl !== target
    )
      throw new Error("Private artifact scope mismatch");
    return artifact as Record<string, unknown>;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname.replace(`/api/personal/attempts/${id}`, "");
      if (request.headers.get("authorization") !== "Bearer synthetic-api-token")
        return new Response(null, { status: 401 });
      events.push(`api:${request.method}:${route}`);
      try {
        if (request.method === "GET" && route === "")
          return Response.json({
            id,
            userId,
            recordId,
            mode,
            state,
            manifest,
            manifestHash: manifestHash(manifest),
            leaseOwner: "synthetic-worker",
            leaseGeneration: generation,
            leaseExpiresAt: new Date(Date.now() + 90000).toISOString(),
          });
        if (request.method === "GET" && route === `/api/personal/${recordId}`)
          return Response.json({
            id: recordId,
            title: "Synthetic Analyst",
            url: posting,
            identity: manifest.identity,
            requisitionId: "123",
          });
        if (request.method !== "POST") return new Response(null, { status: 404 });
        const body = await request.json();
        if (route === "/prepare") {
          state = "prepared";
          return Response.json({ state });
        }
        if (route === "/begin-submit") {
          state = "submitting";
          return Response.json({ state });
        }
        if (route === "/challenge/freeze") {
          if (state !== "submitting" || body.leaseGeneration !== generation)
            throw new Error("Freeze must follow the current submission boundary");
          if (options.rejectFreeze) return new Response(null, { status: 409 });
          frozen = await checkedArtifact(body.evidenceHash, "greenhouse_submission_payload");
          return Response.json({ attemptId: id });
        }
        if (route === "/challenge") {
          challenge = await checkedArtifact(body.evidenceHash, "greenhouse_post_submit_challenge");
          if (
            !frozen ||
            challenge.requestBodyHash !== hash(String(frozen.requestBody)) ||
            JSON.parse(String(challenge.responseBody)).code !== "captcha-failed"
          )
            throw new Error("Challenge is not correlated to the frozen request");
          state = "submission_uncertain";
          generation++;
          return Response.json({ attemptId: id, challenge: { status: "awaiting_user" } });
        }
        if (route === "/receipt") {
          receipt = body.evidence;
          if (!receipt) throw new Error("Receipt is missing");
          const bytes = await readFile(String(receipt.artifactPath), "utf8");
          if (hash(bytes) !== receipt.sha256) throw new Error("Receipt hash mismatch");
          const artifact = JSON.parse(bytes);
          if (
            receipt.outcome === "submitted" &&
            (!frozen || artifact.transport?.requestBodyHash !== hash(String(frozen.requestBody)))
          )
            throw new Error("Acceptance lacks frozen transport correlation");
          state = receipt.outcome === "submitted" ? "submitted" : "submission_uncertain";
          return Response.json({ id, state });
        }
        return new Response(null, { status: 404 });
      } catch (error) {
        failures.push(String(error));
        return new Response(null, { status: 500 });
      }
    },
  });
  const broker = new PersonalBrowserBroker(
    {
      api: `http://127.0.0.1:${server.port}`,
      token: "synthetic-api-token",
      attemptId: id,
      leaseOwner: "synthetic-worker",
      leaseGeneration: 1,
      root,
    },
    driver,
  );
  return {
    broker,
    driver,
    events,
    failures,
    root,
    manifest,
    state: () => state,
    receipt: () => receipt,
    frozen: () => frozen,
    challenge: () => challenge,
    revoke: () => {
      generation++;
    },
    async close() {
      await broker.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  const form = await f.broker.inspectForm();
  const emailField = form.fields.find((field) => field.type === "email");
  const resume = form.fields.find((field) => field.resumeUpload);
  if (!emailField?.answerKey || !resume) throw new Error("Opaque fixture mappings missing");
  await f.broker.fillField(emailField.ref, emailField.answerKey);
  await f.broker.uploadResume(resume.ref);
  return form;
}

describe("Greenhouse broker transport boundaries", () => {
  test("offline never configures or opens the injected employer driver", async () => {
    const f = await fixture("offline");
    try {
      await expect(f.broker.inspectForm()).rejects.toThrow("offline");
      expect(f.events.some((event) => event.startsWith("driver:"))).toBe(false);
      expect(f.frozen()).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  test("live preview can prepare fields but cannot begin submission or freeze a POST", async () => {
    const f = await fixture("live_preview");
    try {
      await prepare(f);
      await expect(f.broker.submitApplication()).rejects.toThrow("prohibited");
      expect(f.events).not.toContain("api:POST:/begin-submit");
      expect(f.events).not.toContain("api:POST:/challenge/freeze");
      expect(f.events).not.toContain("driver:employer-post");
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test("accepted initial submission pins a hashed private request before forwarding and receipt", async () => {
    const f = await fixture("submit");
    try {
      await prepare(f);
      const result = await f.broker.submitApplication();
      expect(result.status).toBe("submitted");
      expect(f.state()).toBe("submitted");
      const order = [
        "api:POST:/begin-submit",
        "api:POST:/challenge/freeze",
        "driver:employer-post",
        "api:POST:/receipt",
      ].map((event) => f.events.indexOf(event));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(JSON.parse(String(f.frozen()!.requestBody)).job_application.email).toBe(email);
      const receipt = JSON.parse(await readFile(String(f.receipt()!.artifactPath), "utf8"));
      expect(receipt.transport).toEqual(f.driver.submissionEvidence());
      expect(JSON.stringify(result)).not.toContain(email);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(f.failures).toEqual([]);
      await expect(f.broker.submitApplication()).rejects.toThrow("cannot be retried");
      expect(f.events.filter((event) => event === "driver:employer-post")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  test("supplied false required consent blocks a prepared attempt before begin-submit or employer POST", async () => {
    const f = await fixture("submit", {
      requiredConsent: true,
      consentAnswer: false,
      startPrepared: true,
    });
    try {
      const form = await prepare(f);
      const consent = form.fields.find((field) => field.type === "checkbox");
      if (!consent?.answerKey) throw new Error("Missing synthetic consent mapping");
      await f.broker.fillField(consent.ref, consent.answerKey);
      expect(f.driver.fields.find((field) => field.type === "checkbox")?.checked).toBe(false);
      expect(f.events.filter((event) => event === "driver:fill")).toHaveLength(2);
      expect(f.events).toContain("driver:upload");
      await expect(f.broker.submitApplication()).rejects.toThrow("affirmatively answered");
      expect(f.state()).toBe("prepared");
      expect(f.events).not.toContain("api:POST:/begin-submit");
      expect(f.events).not.toContain("api:POST:/challenge/freeze");
      expect(f.events).not.toContain("driver:employer-post");
      expect(f.frozen()).toBeUndefined();
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test("required consent reaches submission only after filling an explicitly supplied true answer", async () => {
    const f = await fixture("submit", { requiredConsent: true, consentAnswer: true });
    try {
      const form = await prepare(f);
      const consent = form.fields.find((field) => field.type === "checkbox");
      if (!consent?.answerKey) throw new Error("Missing synthetic consent mapping");
      expect(f.driver.fields.find((field) => field.type === "checkbox")?.checked).toBe(false);
      await expect(f.broker.submitApplication()).rejects.toThrow("supplied answer");
      expect(f.events).not.toContain("api:POST:/begin-submit");
      expect(f.events).not.toContain("driver:employer-post");
      await f.broker.fillField(consent.ref, consent.answerKey);
      expect(f.driver.fields.find((field) => field.type === "checkbox")?.checked).toBe(true);
      expect((await f.broker.submitApplication()).status).toBe("submitted");
      expect(f.events.filter((event) => event === "api:POST:/begin-submit")).toHaveLength(1);
      expect(f.events.filter((event) => event === "driver:employer-post")).toHaveLength(1);
      expect(
        JSON.parse(String(f.frozen()?.requestBody)).job_application.data_compliance
          .gdpr_demographic_data_consent_given,
      ).toBe(true);
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test("a page-checked required consent box cannot replace a missing frozen answer", async () => {
    const f = await fixture("submit", { requiredConsent: true });
    try {
      const form = await prepare(f);
      const consent = form.fields.find((field) => field.type === "checkbox");
      expect(consent?.answerKey).toBeNull();
      expect(consent?.needsAnswer).toBe(true);
      const control = f.driver.fields.find((field) => field.type === "checkbox");
      if (!control) throw new Error("Missing synthetic consent checkbox");
      control.checked = true;
      await expect(f.broker.submitApplication()).rejects.toThrow("supplied answer");
      expect(f.events).not.toContain("api:POST:/begin-submit");
      expect(f.events).not.toContain("driver:employer-post");
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test("recognized response.code challenge uses its private evidence API without an ordinary receipt", async () => {
    const f = await fixture("submit", { challenge: true });
    try {
      await prepare(f);
      const result = await f.broker.submitApplication();
      expect(result.status).toBe("submission_uncertain");
      expect(f.state()).toBe("submission_uncertain");
      expect(f.events).toContain("api:POST:/challenge");
      expect(f.events).not.toContain("api:POST:/receipt");
      expect(f.receipt()).toBeUndefined();
      expect(JSON.parse(String(f.challenge()!.responseBody)).code).toBe("captcha-failed");
      expect(f.challenge()!.requestBodyHash).toBe(hash(String(f.frozen()!.requestBody)));
      expect(JSON.stringify(result)).not.toContain(email);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(f.failures).toEqual([]);
      await expect(f.broker.submitApplication()).rejects.toThrow();
      expect(f.events.filter((event) => event === "driver:employer-post")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  test("a rejected freeze never forwards employer bytes and leaves the boundary uncertain", async () => {
    const f = await fixture("submit", { rejectFreeze: true });
    try {
      await prepare(f);
      expect((await f.broker.submitApplication()).status).toBe("submission_uncertain");
      expect(f.events).toContain("api:POST:/begin-submit");
      expect(f.events).toContain("api:POST:/challenge/freeze");
      expect(f.events).not.toContain("driver:employer-post");
      expect(f.state()).toBe("submission_uncertain");
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test("lease revocation after filling prevents both upload and the final boundary", async () => {
    const f = await fixture("submit");
    try {
      const form = await f.broker.inspectForm();
      const field = form.fields.find((field) => field.type === "email")!;
      const resume = form.fields.find((field) => field.resumeUpload)!;
      await f.broker.fillField(field.ref, field.answerKey!);
      f.revoke();
      await expect(f.broker.uploadResume(resume.ref)).rejects.toThrow("ownership changed");
      await expect(f.broker.submitApplication()).rejects.toThrow("ownership changed");
      expect(f.events).not.toContain("driver:upload");
      expect(f.events).not.toContain("api:POST:/begin-submit");
      expect(f.events).not.toContain("driver:employer-post");
    } finally {
      await f.close();
    }
  });
  test("inspection exposes opaque controls without applicant text, labels, options or file paths", async () => {
    const f = await fixture("live_preview");
    try {
      const result = await f.broker.inspectForm();
      const output = JSON.stringify(result);
      expect(result.privacyScope).toBe("metadata_only");
      expect(result.fields.some((field) => field.answerKey === "answer-0")).toBe(true);
      for (const value of [email, canary, f.root, "synthetic-api-token", "Synthetic Analyst"])
        expect(output).not.toContain(value);
      for (const field of result.fields) {
        expect(field).not.toHaveProperty("label");
        expect(field).not.toHaveProperty("name");
        expect(field).not.toHaveProperty("options");
        expect(field).not.toHaveProperty("value");
      }
      const inspection = await readFile(
        join(f.root, "storage", userId, "inspections", `${id}.json`),
        "utf8",
      );
      expect(inspection).toContain(canary);
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
