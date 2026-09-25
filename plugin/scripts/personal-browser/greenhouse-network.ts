import { createHash } from "node:crypto";

const hostedOrigins = new Set(["https://boards.greenhouse.io", "https://job-boards.greenhouse.io"]);
const uploadOrigin = "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com";
const routeKey = "routes/$url_token_.jobs_.$job_post_id";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(): never {
  throw new Error("Greenhouse request does not match its approved scope");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 4000): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes(String.fromCharCode(0)) ||
    /[\r\n]/.test(value)
  )
    return fail();
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
function equal(a: unknown, b: unknown) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
function json(value: unknown): unknown {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 2_000_000) return fail();
    try {
      return JSON.parse(value);
    } catch {
      return fail();
    }
  }
  return value;
}
function url(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail();
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
    return fail();
  return parsed;
}
function postingUrl(value: string, board: string, postId: string) {
  const parsed = url(value);
  if (!hostedOrigins.has(parsed.origin) || parsed.pathname !== `/${board}/jobs/${postId}`) fail();
  const seen = new Set<string>();
  for (const [key, value] of parsed.searchParams) {
    if (
      seen.has(key) ||
      !["t", "gh_src", "gh_jid", "ccuid"].includes(key) ||
      value.length > 512 ||
      (key === "gh_jid" && value !== postId)
    )
      fail();
    seen.add(key);
  }
  return parsed;
}

interface GreenhouseChoice {
  label: string;
  value: string;
}
interface GreenhouseQuestion {
  name: string;
  type: string;
  required: boolean;
  choices: GreenhouseChoice[];
}
export interface GreenhouseIdentity {
  board: string;
  postId: string;
  title: string;
  fingerprint: string;
  targetUrl: string;
  confirmationPath: string;
  choices: Record<string, GreenhouseChoice[]>;
  questions: GreenhouseQuestion[];
  educationConfig: Record<string, unknown>;
  dataCompliance: Record<string, unknown>;
  demographicQuestions: unknown[];
}

// Published use_month_options.ts plus the English job_post locale bundle.
const englishMonthLabels = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Accept the external route loader, never an arbitrary URL supplied by page text. */
export function parseGreenhouseIdentity(
  actualUrl: string,
  rawLoader: unknown,
  frozenIdentity: string,
): GreenhouseIdentity {
  const match = /^greenhouse:([a-zA-Z0-9_-]{1,100}):([1-9][0-9]{0,19})$/.exec(frozenIdentity);
  if (!match) return fail();
  const board = match[1]!;
  const postId = match[2]!;
  postingUrl(actualUrl, board, postId);
  const outer = object(rawLoader);
  const loader = routeKey in outer ? object(outer[routeKey]) : outer;
  const job = object(loader.jobPost);
  const targetUrl = `https://boards.greenhouse.io/${board}/jobs/${postId}`;
  const confirmationPath = `/${board}/jobs/${postId}/confirmation`;
  if (
    loader.urlToken !== board ||
    loader.jobPostId !== postId ||
    loader.submitPath !== targetUrl ||
    loader.confirmationPath !== confirmationPath ||
    job.post_type !== "job_post" ||
    job.redirect_to != null
  )
    fail();
  postingUrl(string(job.public_url), board, postId);
  const title = string(job.title, 500);
  const fingerprint = string(job.fingerprint, 2000);
  if (!title.trim() || !fingerprint || !Array.isArray(job.questions) || job.questions.length > 200)
    return fail();
  const questions: GreenhouseQuestion[] = [];
  const choices: GreenhouseIdentity["choices"] = {};
  const seen = new Set<string>();
  for (const rawQuestion of job.questions) {
    const question = object(rawQuestion);
    if (
      typeof question.required !== "boolean" ||
      !Array.isArray(question.fields) ||
      !question.fields.length ||
      question.fields.length > 4
    )
      fail();
    for (const rawField of question.fields) {
      const field = object(rawField);
      const name = string(field.name, 200);
      const type = string(field.type, 100);
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]*(?:\[\])?$/.test(name) ||
        seen.has(name) ||
        ![
          "input_text",
          "textarea",
          "input_file",
          "multi_value_single_select",
          "multi_value_multi_select",
        ].includes(type)
      )
        fail();
      seen.add(name);
      const options: GreenhouseChoice[] = [];
      if (field.values !== undefined) {
        if (!Array.isArray(field.values) || field.values.length > 1000) fail();
        for (const rawOption of field.values) {
          const option = object(rawOption);
          if (typeof option.value !== "string" && typeof option.value !== "number") fail();
          const choice = { label: string(option.label), value: String(option.value) };
          if (
            !choice.value ||
            options.some((entry) => entry.value === choice.value || entry.label === choice.label)
          )
            fail();
          options.push(choice);
        }
      }
      choices[name] = options;
      questions.push({ name, type, required: question.required, choices: options });
    }
  }
  const demographicQuestions =
    job.demographic_questions == null ? [] : object(job.demographic_questions).questions;
  if (!Array.isArray(demographicQuestions) || demographicQuestions.length > 200) fail();
  const demographicIds = new Set<number>();
  for (const rawQuestion of demographicQuestions) {
    const question = object(rawQuestion);
    if (
      typeof question.id !== "number" ||
      !Number.isSafeInteger(question.id) ||
      question.id < 1 ||
      demographicIds.has(question.id) ||
      typeof question.required !== "boolean" ||
      !Array.isArray(question.answer_options) ||
      question.answer_options.length > 200
    )
      fail();
    demographicIds.add(question.id);
    const declineChoices: GreenhouseChoice[] = [];
    const optionIds = new Set<number>();
    for (const rawOption of question.answer_options) {
      const option = object(rawOption);
      if (
        typeof option.id !== "number" ||
        !Number.isSafeInteger(option.id) ||
        option.id < 1 ||
        optionIds.has(option.id)
      )
        fail();
      optionIds.add(option.id);
      if (option.decline_to_answer === true && option.free_form === false) {
        const label = string(option.name);
        if (declineChoices.some((choice) => choice.label === label)) fail();
        declineChoices.push({ label, value: String(option.id) });
      }
    }
    choices[`demographic_${question.id}`] = declineChoices;
  }
  const educationConfig = job.education_config == null ? {} : object(job.education_config);
  if (outer.root != null && object(outer.root).locale === "en") {
    for (const name of ["start_month", "end_month"]) {
      if (educationConfig[name] === "required" || educationConfig[name] === "optional")
        choices[name] = englishMonthLabels.map((label, index) => ({
          label,
          value: String(index + 1),
        }));
    }
  }
  return {
    board,
    postId,
    title,
    fingerprint,
    targetUrl,
    confirmationPath,
    choices,
    questions,
    educationConfig,
    dataCompliance: job.data_compliance == null ? {} : object(job.data_compliance),
    demographicQuestions,
  };
}

export interface GreenhousePresign {
  fieldName: string;
  url: string;
  key: string;
  fields: Record<string, string>;
  expiresAt: number;
}
const signingFields = [
  "x-amz-server-side-encryption",
  "success_action_status",
  "policy",
  "x-amz-credential",
  "x-amz-algorithm",
  "x-amz-date",
  "x-amz-security-token",
  "x-amz-signature",
];
export function validateGreenhousePresign(
  requestUrl: string,
  rawBody: unknown,
  allowedFields: readonly string[],
  now = Date.now(),
): Record<string, GreenhousePresign> {
  const request = url(requestUrl);
  const requested = request.searchParams.getAll("fields[]");
  if (
    request.origin !== "https://boards.greenhouse.io" ||
    request.pathname !== "/uncacheable_attributes/presigned_fields" ||
    !requested.length ||
    new Set(requested).size !== requested.length ||
    requested.some((field) => !allowedFields.includes(field)) ||
    [...request.searchParams.keys()].some((key) => key !== "fields[]")
  )
    fail();
  const body = object(json(rawBody));
  keys(body, ["url", ...requested]);
  if (body.url !== uploadOrigin) fail();
  const result: Record<string, GreenhousePresign> = {};
  for (const fieldName of requested) {
    const entry = object(body[fieldName]);
    keys(entry, ["key", "fields"]);
    const key = string(entry.key);
    if (
      !/^stash\/applications\/resumes\/\{timestamp\}-\{unique_id\}-[a-zA-Z0-9_-]{1,200}$/.test(key)
    )
      fail();
    const rawFields = object(entry.fields);
    keys(rawFields, signingFields);
    const fields = Object.fromEntries(
      Object.entries(rawFields).map(([key, value]) => [key, string(value, 20_000)]),
    );
    if (
      fields["x-amz-server-side-encryption"] !== "AES256" ||
      fields.success_action_status !== "201" ||
      fields["x-amz-algorithm"] !== "AWS4-HMAC-SHA256" ||
      !/^[a-f0-9]{64}$/.test(fields["x-amz-signature"] ?? "") ||
      !fields["x-amz-credential"] ||
      !/^\d{8}T\d{6}Z$/.test(fields["x-amz-date"] ?? "")
    )
      fail();
    let policy: Record<string, unknown>;
    try {
      policy = object(JSON.parse(Buffer.from(fields.policy!, "base64").toString("utf8")));
    } catch {
      return fail();
    }
    const expiresAt = Date.parse(string(policy.expiration));
    if (!Number.isFinite(expiresAt) || expiresAt <= now || !Array.isArray(policy.conditions))
      fail();
    const conditions = policy.conditions;
    if (
      !conditions.some((c) => equal(c, { bucket: "grnhse-prod-jben-us-east-1" })) ||
      !conditions.some((c) => equal(c, ["starts-with", "$key", "stash/applications/resumes"])) ||
      !conditions.some((c) => equal(c, ["content-length-range", 1, 104857600]))
    )
      fail();
    for (const condition of conditions) {
      if (Array.isArray(condition)) {
        if (
          !(
            equal(condition, ["content-length-range", 1, 104857600]) ||
            (condition.length === 3 &&
              condition[0] === "starts-with" &&
              ["$utf8", "$authenticity_token", "$key", "$Content-Type"].includes(
                String(condition[1]),
              ) &&
              typeof condition[2] === "string")
          )
        )
          fail();
      } else {
        const values = object(condition);
        for (const [name, value] of Object.entries(values))
          if (name !== "bucket" && fields[name] !== value) fail();
      }
    }
    result[fieldName] = { fieldName, url: uploadOrigin, key, fields, expiresAt };
  }
  return result;
}

export interface GreenhouseUploadedFile {
  fieldName: string;
  name: string;
  sha256: string;
  url: string;
  completed: boolean;
}
export interface GreenhouseUploadEvidence {
  url: string;
  key: string;
  sha256: string;
  bytes: number;
}

/** Parse bounded multipart bytes before forwarding; reject duplicate/extra parts and headers. */
export function validateGreenhouseUpload(
  contentType: string,
  body: Buffer,
  presign: GreenhousePresign,
  expected: { fieldName: string; name: string; sha256: string },
  now = Date.now(),
): GreenhouseUploadEvidence {
  const match =
    /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,100})"|([A-Za-z0-9'()+_,./:=?-]{1,100}))$/.exec(
      contentType,
    );
  if (
    !match ||
    body.length > 105_000_000 ||
    presign.expiresAt <= now ||
    expected.fieldName !== presign.fieldName ||
    presign.url !== uploadOrigin
  )
    return fail();
  const boundary = match[1] ?? match[2]!;
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const start = Buffer.from(`--${boundary}\r\n`);
  if (!body.subarray(0, start.length).equals(start)) return fail();
  let offset = start.length;
  let closed = false;
  let file: Buffer | undefined;
  const values: Record<string, string> = {};
  const names = new Set<string>();
  while (offset < body.length) {
    const endHeaders = body.indexOf("\r\n\r\n", offset);
    if (endHeaders < offset || endHeaders - offset > 2000) return fail();
    const headers = body.subarray(offset, endHeaders).toString("utf8").split("\r\n");
    const disposition =
      /^Content-Disposition: form-data; name="([^"\r\n]+)"(?:; filename="([^"\r\n]*)")?$/i.exec(
        headers[0] ?? "",
      );
    if (!disposition || headers.length > 2) return fail();
    const name = disposition[1]!;
    if (names.has(name)) return fail();
    names.add(name);
    const next = body.indexOf(delimiter, endHeaders + 4);
    if (next < 0) return fail();
    const value = body.subarray(endHeaders + 4, next);
    if (name === "file") {
      if (
        disposition[2] !== expected.name ||
        (headers[1] &&
          !/^Content-Type: (application\/pdf|application\/octet-stream)$/i.test(headers[1]))
      )
        return fail();
      file = value;
    } else {
      if (
        disposition[2] !== undefined ||
        headers.length !== 1 ||
        value.length > 30_000 ||
        ![...signingFields, "utf8", "key", "authenticity_token", "Content-Type"].includes(name)
      )
        return fail();
      values[name] = value.toString("utf8");
    }
    offset = next + delimiter.length;
    if (body.subarray(offset, offset + 2).toString() === "--") {
      offset += 2;
      if (body.subarray(offset).length && body.subarray(offset).toString() !== "\r\n")
        return fail();
      offset = body.length;
      closed = true;
      break;
    }
    if (body.subarray(offset, offset + 2).toString() !== "\r\n") return fail();
    offset += 2;
  }
  if (
    !closed ||
    !file?.length ||
    hash(file) !== expected.sha256 ||
    values.utf8 !== "✓" ||
    values.authenticity_token !== "1234" ||
    values["Content-Type"] !== "application/octet-stream"
  )
    return fail();
  const escaped = presign.key
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\{timestamp\\}", "[0-9]{13}")
    .replace("\\{unique_id\\}", "[a-z0-9]{1,14}");
  if (!new RegExp(`^${escaped}$`).test(values.key ?? "")) fail();
  const expectedValues = {
    ...presign.fields,
    utf8: "✓",
    key: values.key,
    authenticity_token: "1234",
    "Content-Type": "application/octet-stream",
  };
  if (!equal(values, expectedValues)) fail();
  return {
    url: `${presign.url}/${values.key}`,
    key: values.key!,
    sha256: expected.sha256,
    bytes: file.length,
  };
}

export interface GreenhouseFinalContext {
  fields: Record<string, string | boolean>;
  uploads: readonly GreenhouseUploadedFile[];
  timeZone: string;
  /** Supplied only after the driver verifies the approved country's observed dialing code. */
  phoneCountryDialCode?: string;
  selections?: Record<string, GreenhouseChoice>;
  location?: { label: string; latitude: string; longitude: string; countryShortName: string };
  tracking?: { mappedUrlToken: string | null; appcastClickId: string | null };
  continuation?: { securityCode: string; captchaRetried?: boolean };
}
const standard = [
  "first_name",
  "last_name",
  "preferred_name",
  "email",
  "phone",
  "resume_text",
  "cover_letter_text",
  "location",
  "latitude",
  "longitude",
  "country_short_name",
];
const educationFields = [
  "school_name",
  "degree",
  "discipline",
  "start_month",
  "start_year",
  "end_month",
  "end_year",
];
const consentFields = [
  "gdpr_processing_consent_given",
  "gdpr_retention_consent_given",
  "gdpr_consent_given",
  "gdpr_demographic_data_consent_given",
];
const GREENHOUSE_FINAL_ENVELOPE_KEYS = [
  "job_application",
  "fingerprint",
  "g-recaptcha-enterprise-token",
  "security_code",
  "captcha_retried",
] as const;

function approvedSelection(
  name: string,
  identity: GreenhouseIdentity,
  context: GreenhouseFinalContext,
) {
  const approved = context.fields[name];
  const choices = identity.choices[name] ?? [];
  const observed = context.selections?.[name];
  const matches = choices.filter(
    (choice) =>
      choice.label === approved ||
      choice.value === approved ||
      (typeof approved === "boolean" && choice.value === String(Number(approved))),
  );
  if (matches.length === 1) return matches[0]!.value;
  if (choices.length || !observed || (observed.label !== approved && observed.value !== approved))
    return fail();
  return observed.value;
}

/** Build the entire expected application; exact structural comparison rejects covert extra data. */
export function validateGreenhouseFinalRequest(
  rawBody: unknown,
  identity: GreenhouseIdentity,
  context: GreenhouseFinalContext,
): { applicationPayloadHash: string; requestBodyHash: string } {
  const body = object(json(rawBody));
  // The hosted frontend uses JSON.stringify. Reject duplicate keys, hidden bytes and
  // alternate encodings before transmission, even if JSON.parse would discard them.
  if (Buffer.isBuffer(rawBody) && !rawBody.equals(Buffer.from(JSON.stringify(body)))) fail();
  if (typeof rawBody === "string" && rawBody !== JSON.stringify(body)) fail();
  keys(body, GREENHOUSE_FINAL_ENVELOPE_KEYS);
  if (body.fingerprint !== identity.fingerprint) fail();
  if (context.continuation) {
    if (
      !/^[a-zA-Z0-9]{8}$/.test(context.continuation.securityCode) ||
      body.security_code !== context.continuation.securityCode ||
      body["g-recaptcha-enterprise-token"] !== undefined ||
      (body.captcha_retried ?? false) !== (context.continuation.captchaRetried ?? false)
    )
      fail();
  } else if (
    body.security_code !== undefined ||
    body.captcha_retried !== undefined ||
    !string(body["g-recaptcha-enterprise-token"], 20_000)
  )
    fail();
  const fields = context.fields;
  for (const name of Object.keys(fields)) {
    if (
      ![
        ...standard,
        ...educationFields,
        ...consentFields,
        "candidate_location",
        "country",
      ].includes(name) &&
      !(/^demographic_[0-9]+$/.test(name) && Object.hasOwn(identity.choices, name)) &&
      !identity.questions.some((q) => q.name === name && q.type !== "input_file")
    )
      fail();
  }
  const expected: Record<string, unknown> = {
    first_name: "",
    last_name: "",
    email: "",
    answers_attributes: {},
    demographic_answers: [],
    data_compliance: {},
    attachments: {},
    from_job_board_renderer: true,
    employments: [
      {
        start_date: { month: null, year: null },
        end_date: { month: null, year: null },
        current: false,
      },
    ],
  };
  for (const name of standard) {
    const value = fields[name];
    if (value !== undefined && typeof value !== "string") fail();
    if (value) expected[name] = value;
  }
  if (typeof fields.phone === "string" && fields.phone) {
    if (!/^\+?[0-9().\- ]+$/.test(fields.phone)) fail();
    const digits = fields.phone.replace(/[^0-9]/g, "");
    let canonical = fields.phone.startsWith("+") ? `+${digits}` : fields.phone;
    if (!fields.phone.startsWith("+") && context.phoneCountryDialCode) {
      if (!/^[1-9][0-9]{0,3}$/.test(context.phoneCountryDialCode)) fail();
      canonical = `+${context.phoneCountryDialCode}${digits}`;
    }
    if (!/^\+[1-9][0-9]{5,14}$/.test(canonical)) fail();
    expected.phone = canonical;
  }
  if (fields.candidate_location !== undefined) {
    const location = context.location;
    if (
      !location ||
      location.label !== fields.candidate_location ||
      !Number.isFinite(Number(location.latitude)) ||
      Math.abs(Number(location.latitude)) > 90 ||
      !Number.isFinite(Number(location.longitude)) ||
      Math.abs(Number(location.longitude)) > 180 ||
      !/^[A-Z]{2}$/i.test(location.countryShortName)
    )
      fail();
    Object.assign(expected, {
      location: location.label,
      latitude: location.latitude,
      longitude: location.longitude,
      country_short_name: location.countryShortName,
    });
  }
  const uploads = new Map<string, GreenhouseUploadedFile>();
  for (const upload of context.uploads) {
    if (
      uploads.has(upload.fieldName) ||
      !upload.completed ||
      !/^[a-f0-9]{64}$/.test(upload.sha256) ||
      !identity.questions.some((q) => q.name === upload.fieldName && q.type === "input_file")
    )
      fail();
    const target = url(upload.url);
    if (
      target.origin !== uploadOrigin ||
      target.search ||
      !/^\/stash\/applications\/resumes\/[a-zA-Z0-9_-]+$/.test(target.pathname)
    )
      fail();
    uploads.set(upload.fieldName, upload);
    const prefix =
      upload.fieldName === "resume" || upload.fieldName === "cover_letter"
        ? upload.fieldName
        : /^question_([0-9]+)(?:\[\])?$/.exec(upload.fieldName)?.[1];
    if (!prefix) return fail();
    const targetObject =
      prefix === "resume" || prefix === "cover_letter" ? expected : object(expected.attachments);
    targetObject[`${prefix}_url`] = upload.url;
    targetObject[`${prefix}_url_filename`] = upload.name;
  }
  let priority = 0;
  for (const question of identity.questions) {
    if (question.type === "input_file") {
      if (question.required && !uploads.has(question.name) && !fields[`${question.name}_text`])
        fail();
      continue;
    }
    if (question.name === "resume_text" || question.name === "cover_letter_text") continue;
    const value = fields[question.name];
    if (question.required && (value === undefined || value === "")) fail();
    const id = /^question_([0-9]+)(?:\[\])?$/.exec(question.name)?.[1];
    if (!id) continue;
    const answer: Record<string, unknown> = { question_id: id, priority: priority++ };
    if (question.type === "input_text" || question.type === "textarea") {
      if (value !== undefined) {
        if (typeof value !== "string") fail();
        answer.text_value = value;
      }
    } else if (question.type === "multi_value_single_select") {
      if (value === undefined || value === "") answer.answer_selected_options_attributes = {};
      else {
        const selected = approvedSelection(question.name, identity, context);
        if (selected === "0" || selected === "1") answer.boolean_value = Number(selected);
        else {
          const received = object(
            object(object(object(body.job_application).answers_attributes)[id])
              .answer_selected_options_attributes,
          )["0"];
          const wireId = object(received).question_option_id;
          if (
            (typeof wireId !== "string" && typeof wireId !== "number") ||
            String(wireId) !== selected
          )
            fail();
          answer.answer_selected_options_attributes = { "0": { question_option_id: wireId } };
        }
      }
    } else if (question.type === "multi_value_multi_select") {
      if (value !== undefined && value !== "") fail();
      answer.answer_selected_options_attributes = {};
    } else fail();
    object(expected.answers_attributes)[id] = answer;
  }
  const education: Record<string, unknown> = {
    school_name_id: null,
    degree_id: null,
    discipline_id: null,
    start_date: { month: null, year: null },
    end_date: { month: null, year: null },
  };
  for (const name of educationFields) {
    const value = fields[name];
    if (identity.educationConfig[name] === "required" && (value === undefined || value === ""))
      fail();
    if (value === undefined || value === "") continue;
    if (
      identity.educationConfig[name] !== "required" &&
      identity.educationConfig[name] !== "optional"
    )
      fail();
    if (["school_name", "degree", "discipline"].includes(name))
      education[`${name}_id`] = approvedSelection(name, identity, context);
    else {
      const [section, unit] = name.split("_");
      if (typeof value !== "string") fail();
      if (unit === "month") {
        const selected = context.selections?.[name] || identity.choices[name]?.length;
        const number = Number(selected ? approvedSelection(name, identity, context) : value);
        if (!Number.isInteger(number) || number < 1 || number > 12) fail();
        object(education[`${section}_date`]).month = number;
      } else {
        if (!/^[12][0-9]{3}$/.test(value)) fail();
        object(education[`${section}_date`]).year = value;
      }
    }
  }
  expected.educations = [education];
  const compliance: Record<string, unknown> = {};
  const config = identity.dataCompliance;
  if (config.single_purpose_consent) {
    if (config.requires_processing_consent) compliance.gdpr_processing_consent_given = false;
    if (config.requires_retention_consent) compliance.gdpr_retention_consent_given = false;
    if (config.demographic_data_consent_applies && identity.demographicQuestions.length)
      compliance.gdpr_demographic_data_consent_given = false;
  } else if (config.retention_period) compliance.gdpr_consent_given = false;
  for (const name of consentFields)
    if (fields[name] !== undefined) {
      if (!(name in compliance) || typeof fields[name] !== "boolean") fail();
      compliance[name] = fields[name];
    }
  const demographicAnswers: {
    question_id: number;
    answer_options: { answer_option_id: string }[];
  }[] = [];
  for (const rawQuestion of identity.demographicQuestions) {
    const question = object(rawQuestion);
    const name = `demographic_${question.id}`;
    const value = fields[name];
    if (value === undefined || value === "") {
      if (question.required === true) fail();
      continue;
    }
    if (typeof value !== "string") fail();
    const choices = identity.choices[name] ?? [];
    const selected = choices.filter((choice) => choice.value === value || choice.label === value);
    if (selected.length !== 1 || typeof question.id !== "number") fail();
    const option = (question.answer_options as unknown[])
      .map(object)
      .find((entry) => String(entry.id) === selected[0]!.value);
    if (option?.decline_to_answer !== true || option.free_form !== false) fail();
    demographicAnswers.push({
      question_id: question.id,
      answer_options: [{ answer_option_id: selected[0]!.value }],
    });
  }
  expected.demographic_answers = demographicAnswers;
  expected.data_compliance = compliance;
  expected.mapped_url_token = context.tracking?.mappedUrlToken ?? null;
  expected.appcast_click_id = context.tracking?.appcastClickId ?? null;
  expected.time_zone = string(context.timeZone, 100);
  if (!context.timeZone || !equal(body.job_application, expected)) fail();
  const raw = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === "string"
      ? rawBody
      : JSON.stringify(body);
  return {
    applicationPayloadHash: hash(JSON.stringify(stable(expected))),
    requestBodyHash: hash(raw),
  };
}

const GREENHOUSE_CHALLENGE_CODES = [
  "captcha-failed",
  "captcha-retry",
  "invalid-security-code",
  "expired-security-code",
  "security-code-error",
] as const;
export function classifyGreenhouseResponse(
  status: number,
  rawBody: unknown,
): { kind: "accepted" | "challenge" | "rejected" | "uncertain"; code?: string } {
  let body: Record<string, unknown> = {};
  try {
    const bytes = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    if (typeof bytes !== "string" || bytes.trim()) body = object(json(bytes));
  } catch {
    return { kind: "uncertain" };
  }
  const code = typeof body.code === "string" ? body.code : undefined;
  if (
    status >= 400 &&
    status < 500 &&
    code &&
    GREENHOUSE_CHALLENGE_CODES.some((known) => known === code)
  )
    return { kind: "challenge", code };
  if (
    status >= 400 &&
    status < 500 &&
    ["invalid-attributes", "invalid-attachment"].includes(code ?? "")
  )
    return { kind: "rejected", code };
  if (status >= 200 && status < 300 && !("code" in body) && !("error" in body))
    return { kind: "accepted" };
  return { kind: "uncertain" };
}

/** Confirmation is public: only use it alongside the same attempt's captured POST receipt. */
export function isGreenhouseConfirmationEvidence(
  identity: GreenhouseIdentity,
  receipt: {
    targetUrl: string;
    requestBodyHash: string;
    applicationPayloadHash: string;
    responseStatus: number;
    responseBody: string;
  },
  confirmationUrl: string,
  expected: { requestBodyHash: string; applicationPayloadHash: string },
): boolean {
  try {
    const target = url(confirmationUrl);
    return (
      hostedOrigins.has(target.origin) &&
      target.pathname === identity.confirmationPath &&
      !target.search &&
      receipt.targetUrl === identity.targetUrl &&
      /^[a-f0-9]{64}$/.test(expected.requestBodyHash) &&
      /^[a-f0-9]{64}$/.test(expected.applicationPayloadHash) &&
      receipt.requestBodyHash === expected.requestBodyHash &&
      receipt.applicationPayloadHash === expected.applicationPayloadHash &&
      classifyGreenhouseResponse(receipt.responseStatus, receipt.responseBody).kind === "accepted"
    );
  } catch {
    return false;
  }
}
