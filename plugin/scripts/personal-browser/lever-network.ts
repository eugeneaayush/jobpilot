import { createHash } from "node:crypto";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const postingPath =
  /^\/([a-zA-Z0-9_-]{1,100})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/;
export function parseLeverIdentity(value: string, identity: string) {
  const url = new URL(value);
  const region = url.host === "jobs.eu.lever.co" ? "eu" : "global";
  const match = postingPath.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["jobs.lever.co", "jobs.eu.lever.co"].includes(url.host) ||
    !match ||
    identity !== `lever:${region}:${match[1]}:${match[2]}`
  )
    throw new Error("needs_user: Lever hosted posting identity is unverified");
  const postingUrl = `${url.origin}/${match[1]}/${match[2]}`;
  return {
    identity,
    region,
    board: match[1]!,
    postingId: match[2]!,
    origin: url.origin,
    postingUrl,
    applyUrl: `${postingUrl}/apply`,
  };
}
export type LeverIdentity = ReturnType<typeof parseLeverIdentity>;
export interface LeverWireField {
  name: string;
  type: string;
  required: boolean;
  value: string;
  checked?: boolean;
  choices: { label: string; value: string }[];
  widget?: "native" | "radio";
}
export interface LeverFinalContext {
  fields: LeverWireField[];
  approved: Record<string, string | boolean>;
  files: Record<string, { filename: string; sha256: string; bytes: number }>;
  hidden: Record<string, string>;
}

async function readMultipart(
  request: { targetUrl: string; contentType: string; body: Buffer },
  identity: LeverIdentity,
) {
  if (
    request.targetUrl !== identity.applyUrl ||
    !/^multipart\/form-data;\s*boundary=(?:"[A-Za-z0-9'()+_,./:=?-]{1,100}"|[A-Za-z0-9'()+_,./:=?-]{1,100})$/i.test(
      request.contentType,
    ) ||
    request.body.length > 14_000_000 ||
    !request.body.length
  )
    throw new Error("needs_user: Unsupported Lever hosted final request");
  const boundary = request.contentType.replace(/^.*boundary=/i, "").replace(/^"|"$/g, "");
  const wire = request.body.toString("latin1");
  const first = `--${boundary}\r\n`;
  const closing = `\r\n--${boundary}--`;
  const trimmed = wire.endsWith("\r\n") ? wire.slice(0, -2) : wire;
  if (!trimmed.startsWith(first) || !trimmed.endsWith(closing))
    throw new Error("needs_user: Lever multipart framing is invalid");
  const parts = trimmed.slice(first.length, -closing.length).split(`\r\n--${boundary}\r\n`);
  if (parts.length > 220)
    throw new Error("needs_user: Lever multipart field count exceeds its bound");
  for (const part of parts) {
    const end = part.indexOf("\r\n\r\n");
    if (end < 0 || end > 4096) throw new Error("needs_user: Lever multipart headers are invalid");
    const headers = part.slice(0, end).split("\r\n");
    if (
      !/^Content-Disposition: form-data; name="[^"\r\n]+"(?:; filename="[^"\r\n]*")?$/i.test(
        headers[0] ?? "",
      ) ||
      headers.length > 2 ||
      (headers.length === 2 &&
        !/^Content-Type: (?:application\/pdf|application\/octet-stream)$/i.test(headers[1] ?? ""))
    )
      throw new Error("needs_user: Lever multipart has unapproved transport metadata");
  }
  const form = await new Response(new Uint8Array(request.body).buffer, {
    headers: { "content-type": request.contentType },
  }).formData();
  const names = [...form.keys()];
  if (names.length !== parts.length || new Set(names).size !== names.length)
    throw new Error("needs_user: Lever multipart fields are duplicated or ambiguous");
  return form;
}

async function wirePayloadHash(form: FormData) {
  const entries: [string, unknown][] = [];
  for (const name of form.keys()) {
    const value = form.get(name)!;
    if (!name || name.length > 500)
      throw new Error("needs_user: Lever multipart field name is invalid");
    entries.push([
      name,
      typeof value === "string"
        ? value
        : {
            filename: value.name,
            mimeType: value.type,
            sha256: digest(new Uint8Array(await value.arrayBuffer())),
            bytes: value.size,
          },
    ]);
  }
  return digest(JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Verifies a private artifact without trusting caller-provided request or payload digests. */
export async function readLeverFrozenRequest(
  requestBody: string,
  identity: LeverIdentity,
  targetUrl: string,
) {
  if (requestBody.length > 19_000_000)
    throw new Error("needs_user: Lever frozen request exceeds its bound");
  const value: unknown = JSON.parse(requestBody);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("needs_user: Invalid Lever frozen request");
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(",") !==
      "applicationPayloadHash,bodyBase64,contentType,kind,requestBodyHash,schemaVersion" ||
    envelope.schemaVersion !== 1 ||
    envelope.kind !== "lever_hosted_multipart" ||
    typeof envelope.contentType !== "string" ||
    typeof envelope.bodyBase64 !== "string" ||
    typeof envelope.requestBodyHash !== "string" ||
    typeof envelope.applicationPayloadHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.requestBodyHash) ||
    !/^[a-f0-9]{64}$/.test(envelope.applicationPayloadHash)
  )
    throw new Error("needs_user: Invalid Lever frozen request fields");
  const body = Buffer.from(envelope.bodyBase64, "base64");
  if (body.toString("base64") !== envelope.bodyBase64)
    throw new Error("needs_user: Lever request encoding is not canonical");
  const form = await readMultipart(
    { targetUrl, contentType: envelope.contentType, body },
    identity,
  );
  const requestBodyHash = digest(body);
  const applicationPayloadHash = await wirePayloadHash(form);
  if (
    requestBodyHash !== envelope.requestBodyHash ||
    applicationPayloadHash !== envelope.applicationPayloadHash
  )
    throw new Error("needs_user: Lever frozen request digest changed");
  return { requestBodyHash, applicationPayloadHash };
}

export async function validateLeverFinalRequest(
  request: { targetUrl: string; contentType: string; body: Buffer },
  identity: LeverIdentity,
  context: LeverFinalContext,
) {
  const form = await readMultipart(request, identity);
  const names = new Set(context.fields.map((field) => field.name));
  if (names.size !== context.fields.length || names.has("") || context.fields.length > 200)
    throw new Error("needs_user: Lever fields are ambiguous");
  for (const field of context.fields) {
    const values = form.getAll(field.name);
    const approved = context.approved[field.name];
    if (field.type === "file") {
      const expected = context.files[field.name];
      if (!expected) {
        if (
          field.required ||
          values.length > 1 ||
          values.some((value) => typeof value === "string" || value.size > 0 || value.name)
        )
          throw new Error("needs_user: Lever file lacks frozen evidence");
        continue;
      }
      const file = values[0];
      if (
        values.length !== 1 ||
        !file ||
        typeof file === "string" ||
        file.type !== "application/pdf" ||
        file.name !== expected.filename ||
        file.size !== expected.bytes
      )
        throw new Error("needs_user: Lever attachment metadata changed");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (
        digest(bytes) !== expected.sha256 ||
        Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-"
      )
        throw new Error("needs_user: Lever attachment bytes changed");
      continue;
    }
    if (field.type === "checkbox") {
      if (
        (field.required && approved !== true) ||
        (approved !== undefined && typeof approved !== "boolean") ||
        (approved === true ? values.length !== 1 || values[0] !== field.value : values.length !== 0)
      )
        throw new Error("needs_user: Lever consent lacks an exact approved answer");
      continue;
    }
    if (approved === undefined && field.required)
      throw new Error("needs_user: Required Lever question has no approved answer");
    if (approved !== undefined && typeof approved !== "string")
      throw new Error("needs_user: Lever text question requires explicit text");
    let expected = approved ?? "";
    if (field.type === "select" && approved !== undefined) {
      const choices = field.choices.filter(
        (choice) => choice.label === approved || choice.value === approved,
      );
      if (choices.length !== 1) throw new Error("needs_user: Lever selection is ambiguous");
      expected = choices[0]!.value;
    }
    if (field.widget === "radio" && !expected && !values.length) continue;
    if (values.length !== 1 || values[0] !== expected.replace(/\r\n|\r|\n/g, "\r\n"))
      throw new Error("needs_user: Lever final answer differs from the approved value");
  }
  for (const [name, value] of Object.entries(context.hidden)) {
    if (
      names.has(name) ||
      !/^(?:_csrf|csrf|csrf_token|csrfToken|authenticity_token|utf8)$/.test(name) ||
      value.length > 4096 ||
      form.getAll(name).length !== 1 ||
      form.get(name) !== value
    )
      throw new Error("needs_user: Lever hidden form state changed or is unsupported");
  }
  for (const name of form.keys())
    if (!names.has(name) && !Object.hasOwn(context.hidden, name))
      throw new Error("needs_user: Lever request includes an unapproved field");
  for (const name of [...Object.keys(context.approved), ...Object.keys(context.files)])
    if (!names.has(name)) throw new Error("needs_user: An approved Lever field disappeared");
  const requestBodyHash = digest(request.body);
  const applicationPayloadHash = await wirePayloadHash(form);
  return {
    requestBodyHash,
    applicationPayloadHash,
    frozenRequest: JSON.stringify({
      schemaVersion: 1,
      kind: "lever_hosted_multipart",
      contentType: request.contentType,
      bodyBase64: request.body.toString("base64"),
      requestBodyHash,
      applicationPayloadHash,
    }),
  };
}
