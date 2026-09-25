import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
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
type Snapshot = Awaited<ReturnType<BrowserDriver["snapshot"]>>;
async function fixture(
  options: {
    mode?: "submit" | "live_preview";
    attachmentRequired?: boolean;
    fieldRequired?: boolean;
    extraRequired?: boolean;
    duplicate?: boolean;
    pathScope?: "foreign" | "symlink";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "attachment-broker-synthetic-"));
  const own = join(root, "storage", userId);
  await mkdir(own, { recursive: true });
  const resumePath = join(own, "resume.pdf"),
    attachmentPath = join(own, "private-cover.pdf");
  const resumeBytes = "%PDF synthetic resume",
    attachmentBytes = "%PDF private synthetic applicant narrative CANARY_APPLICANT";
  await writeFile(resumePath, resumeBytes);
  await writeFile(attachmentPath, attachmentBytes);
  let frozenPath = attachmentPath;
  if (options.pathScope) {
    const foreign = join(root, "storage", "44444444-4444-4444-8444-444444444444");
    await mkdir(foreign, { recursive: true });
    const foreignPath = join(foreign, "other-applicant.pdf");
    await writeFile(foreignPath, attachmentBytes);
    if (options.pathScope === "foreign") frozenPath = foreignPath;
    else {
      frozenPath = join(own, "linked.pdf");
      await symlink(foreignPath, frozenPath);
    }
  }
  const fields: Snapshot["fields"] = [
    {
      ref: "field-0",
      name: "email",
      label: "Private applicant email CANARY_LABEL",
      type: "email",
      required: true,
      value: "",
      options: [],
    },
    {
      ref: "field-1",
      name: "resume",
      label: "Resume",
      type: "file",
      required: true,
      value: "",
      options: [],
    },
    {
      ref: "field-2",
      name: "cover_letter",
      label: "Private cover CANARY_LABEL",
      type: "file",
      required: options.fieldRequired ?? true,
      value: "",
      options: [],
    },
  ];
  if (options.extraRequired)
    fields.push({
      ref: "field-3",
      name: "transcript",
      label: "Transcript",
      type: "file",
      required: true,
      value: "",
      options: [],
    });
  if (options.duplicate) fields.push({ ...fields[2]!, ref: "field-3" });
  const events: string[] = [];
  const uploads: { field: string; path: string; bytes: string }[] = [];
  let url = "",
    state = "prepared",
    submitted = false;
  const email = "private-synthetic@example.test";
  const manifest = {
    identity: "greenhouse:synthetic:123",
    canonicalUrl: "",
    applicantEmail: email,
    answers: [{ key: "email", fieldName: "email", value: email }],
    document: { path: resumePath, sha256: hash(resumeBytes) },
    attachments: [
      {
        fieldName: "cover_letter",
        label: "Cover for CANARY_APPLICANT",
        path: frozenPath,
        sha256: hash(attachmentBytes),
        required: options.attachmentRequired ?? true,
      },
    ],
  };
  const driver: BrowserDriver = {
    open: async () => {
      events.push("browser-open");
    },
    snapshot: async () => ({
      url,
      text: `Synthetic Analyst CANARY_PAGE ${email}`,
      fields: fields.map((field) => ({ ...field })),
      securityBlock: false,
      submitCount: 1,
      submitAction: `${new URL(url).origin}/confirmation`,
      submitMethod: "POST",
      ...(submitted
        ? { confirmationHeading: true, confirmationText: `Synthetic Analyst ${email}` }
        : {}),
    }),
    fill: async (field, value) => {
      const match = fields.find((item) => item.ref === field.ref);
      if (match) match.value = String(value);
    },
    upload: async (field, path, bytes) => {
      uploads.push({ field: field.name, path, bytes: bytes.toString() });
      const match = fields.find((item) => item.ref === field.ref);
      if (match) {
        match.value = `C:\\fakepath\\${field.name}.pdf`;
        match.fileHashes = [hash(bytes)];
      }
    },
    submit: async () => {
      events.push("browser-submit");
      submitted = true;
    },
    close: async () => {},
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (request.headers.get("authorization") !== "Bearer synthetic-token")
        return new Response(null, { status: 401 });
      if (pathname === `/api/personal/attempts/${attemptId}`)
        return Response.json({
          id: attemptId,
          userId,
          recordId,
          mode: options.mode ?? "submit",
          state,
          manifest,
          manifestHash: hash(JSON.stringify(stable(manifest))),
          leaseOwner: "synthetic-owner",
          leaseGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      if (pathname === `/api/personal/${recordId}`)
        return Response.json({
          id: recordId,
          url,
          title: "Synthetic Analyst",
          identity: manifest.identity,
          requisitionId: "123",
        });
      if (pathname.endsWith("/begin-submit")) {
        events.push("begin-submit");
        state = "submitting";
        return Response.json({ state });
      }
      if (pathname.endsWith("/receipt")) {
        events.push("receipt");
        state = "submitted";
        return Response.json({ state });
      }
      return new Response(null, { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}/jobs/123`;
  manifest.canonicalUrl = url;
  const broker = new PersonalBrowserBroker(
    {
      api: `http://127.0.0.1:${server.port}`,
      token: "synthetic-token",
      attemptId,
      leaseOwner: "synthetic-owner",
      leaseGeneration: 1,
      root,
    },
    driver,
  );
  async function prepare() {
    await broker.inspectForm();
    await broker.fillField("field-0", "answer-0");
    await broker.uploadResume("field-1");
  }
  return {
    broker,
    prepare,
    fields,
    manifest,
    attachmentPath,
    events,
    uploads,
    root,
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

describe("private browser attachments", () => {
  test("model sees only opaque attachment keys and types, while upload uses frozen private bytes", async () => {
    const f = await fixture();
    try {
      const inspection = await f.broker.call("inspect_form", {});
      const serialized = JSON.stringify(inspection);
      expect(serialized).toContain('"attachmentKey":"attachment-0"');
      for (const canary of [
        "CANARY_APPLICANT",
        "CANARY_LABEL",
        "CANARY_PAGE",
        "private-synthetic@example.test",
        "cover_letter",
        f.root,
      ])
        expect(serialized).not.toContain(canary);
      const uploaded = await f.broker.call("upload_attachment", {
        ref: "field-2",
        attachmentKey: "attachment-0",
      });
      expect(uploaded).toEqual({
        status: "uploaded",
        transmitting: true,
        attachmentKey: "attachment-0",
      });
      expect(f.uploads).toHaveLength(1);
      expect(f.uploads[0]?.bytes).toContain("CANARY_APPLICANT");
      expect(f.events).not.toContain("begin-submit");
    } finally {
      await f.close();
    }
  });
  test("rejects wrong field, unknown index, caller paths, and duplicate field identities", async () => {
    const f = await fixture();
    try {
      await f.broker.inspectForm();
      for (const [ref, key] of [
        ["field-1", "attachment-0"],
        ["field-2", "attachment-99"],
        ["missing", "attachment-0"],
      ])
        await expect(f.broker.uploadAttachment(ref!, key!)).rejects.toThrow(
          "unique observed field",
        );
      await expect(
        f.broker.call("upload_attachment", {
          ref: "field-2",
          attachmentKey: "attachment-0",
          path: f.attachmentPath,
        }),
      ).rejects.toThrow("unauthorized");
      expect(f.uploads).toHaveLength(0);
    } finally {
      await f.close();
    }
    const duplicate = await fixture({ duplicate: true });
    try {
      await duplicate.broker.inspectForm();
      await expect(duplicate.broker.uploadAttachment("field-2", "attachment-0")).rejects.toThrow(
        "unique observed field",
      );
    } finally {
      await duplicate.close();
    }
  });
  test("confines resolved attachment paths to the authenticated user's storage", async () => {
    for (const pathScope of ["foreign", "symlink"] as const) {
      const f = await fixture({ pathScope });
      try {
        await f.broker.inspectForm();
        await expect(f.broker.uploadAttachment("field-2", "attachment-0")).rejects.toThrow(
          "outside private user storage",
        );
        expect(f.uploads).toHaveLength(0);
      } finally {
        await f.close();
      }
    }
  });
  test("rejects replaced bytes before any upload", async () => {
    const f = await fixture();
    try {
      await f.broker.inspectForm();
      await writeFile(f.attachmentPath, "replacement CANARY_OTHER");
      await expect(f.broker.uploadAttachment("field-2", "attachment-0")).rejects.toThrow(
        "hash mismatch",
      );
      expect(f.uploads).toHaveLength(0);
      expect(f.events).not.toContain("begin-submit");
    } finally {
      await f.close();
    }
  });
  test("required frozen attachment blocks final boundary even when the page field is optional", async () => {
    const f = await fixture({ fieldRequired: false });
    try {
      await f.prepare();
      await expect(f.broker.submitApplication()).rejects.toThrow("required frozen attachment");
      expect(f.events).not.toContain("begin-submit");
      await f.broker.uploadAttachment("field-2", "attachment-0");
      expect((await f.broker.submitApplication()).status).toBe("submitted");
      expect(f.events.indexOf("begin-submit")).toBeLessThan(f.events.indexOf("browser-submit"));
    } finally {
      await f.close();
    }
  });
  test("required observed file blocks final boundary even when the frozen attachment is optional", async () => {
    const f = await fixture({ attachmentRequired: false });
    try {
      await f.prepare();
      await expect(f.broker.submitApplication()).rejects.toThrow("Required file field");
      expect(f.events).not.toContain("begin-submit");
      await f.broker.uploadAttachment("field-2", "attachment-0");
      expect((await f.broker.submitApplication()).status).toBe("submitted");
    } finally {
      await f.close();
    }
  });
  test("unmapped required file remains blocked after all available uploads", async () => {
    const f = await fixture({ extraRequired: true });
    try {
      await f.prepare();
      await f.broker.uploadAttachment("field-2", "attachment-0");
      await expect(f.broker.submitApplication()).rejects.toThrow("Required file field");
      expect(f.events).not.toContain("begin-submit");
    } finally {
      await f.close();
    }
  });
  test("live preview can upload but cannot reach final submission", async () => {
    const f = await fixture({ mode: "live_preview" });
    try {
      await f.prepare();
      await f.broker.uploadAttachment("field-2", "attachment-0");
      await expect(f.broker.submitApplication()).rejects.toThrow("prohibited");
      expect(f.events).not.toContain("begin-submit");
      expect(f.events).not.toContain("browser-submit");
    } finally {
      await f.close();
    }
  });
  test("cleared required file after upload cannot cross the final boundary", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      await f.broker.uploadAttachment("field-2", "attachment-0");
      f.fields[2]!.value = "";
      f.fields[2]!.fileHashes = [];
      await expect(f.broker.submitApplication()).rejects.toThrow();
      expect(f.events).not.toContain("begin-submit");
    } finally {
      await f.close();
    }
  });
  test("replaced, removed, ambiguous or multiple selected files cannot reach begin-submit", async () => {
    for (const mutation of ["replaced", "removed", "ambiguous", "multiple"] as const) {
      const f = await fixture();
      try {
        await f.prepare();
        await f.broker.uploadAttachment("field-2", "attachment-0");
        if (mutation === "replaced") f.fields[2]!.fileHashes = [hash("other bytes")];
        if (mutation === "removed") f.fields.splice(2, 1);
        if (mutation === "ambiguous") f.fields.push({ ...f.fields[2]!, ref: "field-4" });
        if (mutation === "multiple") f.fields[2]!.fileHashes!.push(hash("extra file"));
        await expect(f.broker.submitApplication()).rejects.toThrow("Observed attachment changed");
        expect(f.events).not.toContain("begin-submit");
      } finally {
        await f.close();
      }
    }
  });
});
