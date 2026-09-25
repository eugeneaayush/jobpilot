import { createHash } from "node:crypto";
import {
  parseLeverIdentity,
  readLeverFrozenRequest,
  validateLeverFinalRequest,
} from "../../../../../plugin/scripts/personal-browser/lever-network";
import { describe, expect, test } from "bun:test";

const id = "11111111-1111-4111-8111-111111111111";
const url = `https://jobs.lever.co/synthetic/${id}`;
const identity = `lever:global:synthetic:${id}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pdf = new TextEncoder().encode("%PDF-SYNTHETIC");
const fields = [
  {
    name: "email",
    type: "email",
    required: true,
    value: "person@example.test",
    checked: false,
    choices: [],
  },
  {
    name: "cards[0][field0]",
    type: "select",
    required: true,
    value: "yes",
    checked: false,
    choices: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  { name: "consent", type: "checkbox", required: true, value: "on", checked: true, choices: [] },
  {
    name: "resume",
    type: "file",
    required: true,
    value: "resume.pdf",
    checked: false,
    choices: [],
  },
];
async function request(change?: (body: FormData) => void) {
  const form = new FormData();
  form.set("email", "person@example.test");
  form.set("cards[0][field0]", "yes");
  form.set("consent", "on");
  form.set("resume", new File([pdf], "resume.pdf", { type: "application/pdf" }));
  form.set("_csrf", "synthetic-token");
  change?.(form);
  const encoded = new Request(`${url}/apply`, { method: "POST", body: form });
  return {
    targetUrl: encoded.url,
    contentType: encoded.headers.get("content-type")!,
    body: Buffer.from(await encoded.arrayBuffer()),
  };
}
const context = {
  fields,
  approved: { email: "person@example.test", "cards[0][field0]": "Yes", consent: true },
  files: { resume: { filename: "resume.pdf", sha256: hash(pdf), bytes: pdf.length } },
  hidden: { _csrf: "synthetic-token" },
};
describe("Lever hosted identity", () => {
  test("binds site, posting and region without interchangeable global/EU identities", () => {
    expect(parseLeverIdentity(url, identity).applyUrl).toBe(`${url}/apply`);
    expect(
      parseLeverIdentity(
        url.replace("jobs.lever.co", "jobs.eu.lever.co"),
        identity.replace("global", "eu"),
      ).region,
    ).toBe("eu");
    for (const invalid of [
      url.replace("https:", "http:"),
      url.replace("jobs.lever.co", "jobs.lever.co.evil.test"),
      `${url}/other`,
      `${url}?email=person@example.test`,
      url.replace("synthetic", "other"),
    ])
      expect(() => parseLeverIdentity(invalid, identity)).toThrow();
    expect(() => parseLeverIdentity(url, identity.replace("global", "eu"))).toThrow();
  });
});
describe("Lever final multipart bytes", () => {
  test("independently verifies the frozen envelope and rejects digest or encoding changes", async () => {
    const scope = parseLeverIdentity(url, identity);
    const result = await validateLeverFinalRequest(await request(), scope, context);
    expect(await readLeverFrozenRequest(result.frozenRequest, scope, scope.applyUrl)).toEqual({
      requestBodyHash: result.requestBodyHash,
      applicationPayloadHash: result.applicationPayloadHash,
    });
    const frozen = JSON.parse(result.frozenRequest);
    for (const change of [
      { requestBodyHash: "0".repeat(64) },
      { applicationPayloadHash: "0".repeat(64) },
      { bodyBase64: `${frozen.bodyBase64}\n` },
      { extra: "unapproved" },
    ])
      await expect(
        readLeverFrozenRequest(JSON.stringify({ ...frozen, ...change }), scope, scope.applyUrl),
      ).rejects.toThrow();
  });
  test("binds every custom answer, consent, observed token and PDF bytes", async () => {
    const wire = await request();
    const result = await validateLeverFinalRequest(
      wire,
      parseLeverIdentity(url, identity),
      context,
    );
    expect(result.requestBodyHash).toBe(hash(wire.body));
    expect(result.applicationPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.frozenRequest).bodyBase64).toBe(wire.body.toString("base64"));
  });
  test.each([
    "answer",
    "extra",
    "duplicate",
    "file",
    "token",
    "omitted",
  ])("rejects final %s mutation", async (mode) => {
    const wire = await request((body) => {
      if (mode === "answer") body.set("email", "other@example.test");
      if (mode === "extra") body.set("unapproved", "PRIVATE_CANARY");
      if (mode === "duplicate") body.append("email", "person@example.test");
      if (mode === "file")
        body.set("resume", new File(["altered"], "resume.pdf", { type: "application/pdf" }));
      if (mode === "token") body.set("_csrf", "changed-token");
      if (mode === "omitted") body.delete("consent");
    });
    await expect(
      validateLeverFinalRequest(wire, parseLeverIdentity(url, identity), context),
    ).rejects.toThrow();
  });
  test("rejects absent mandatory answers and an unobserved target or encoding", async () => {
    const wire = await request();
    const site = parseLeverIdentity(url, identity);
    await expect(
      validateLeverFinalRequest(wire, site, {
        ...context,
        approved: { email: "person@example.test" },
      }),
    ).rejects.toThrow();
    await expect(
      validateLeverFinalRequest(
        { ...wire, targetUrl: `https://api.lever.co/v0/postings/synthetic/${id}` },
        site,
        context,
      ),
    ).rejects.toThrow();
    await expect(
      validateLeverFinalRequest({ ...wire, contentType: "application/json" }, site, context),
    ).rejects.toThrow();
  });
  test("rejects ignored multipart headers and trailing wire bytes", async () => {
    const wire = await request();
    const site = parseLeverIdentity(url, identity);
    const injected = Buffer.from(
      wire.body
        .toString("latin1")
        .replace(
          'Content-Disposition: form-data; name="email"\r\n',
          'Content-Disposition: form-data; name="email"\r\nX-Private: UNAPPROVED\r\n',
        ),
      "latin1",
    );
    await expect(
      validateLeverFinalRequest({ ...wire, body: injected }, site, context),
    ).rejects.toThrow();
    await expect(
      validateLeverFinalRequest(
        { ...wire, body: Buffer.concat([wire.body, Buffer.from("UNAPPROVED")]) },
        site,
        context,
      ),
    ).rejects.toThrow();
  });
});
