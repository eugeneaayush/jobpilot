import { createHash } from "node:crypto";
import {
  classifyGreenhouseResponse,
  type GreenhouseFinalContext,
  isGreenhouseConfirmationEvidence,
  parseGreenhouseIdentity,
  validateGreenhouseFinalRequest,
  validateGreenhousePresign,
  validateGreenhouseUpload,
} from "../../../../../plugin/scripts/personal-browser/greenhouse-network";
import { describe, expect, test } from "bun:test";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const posting = "https://job-boards.greenhouse.io/synthetic/jobs/123";
const target = "https://boards.greenhouse.io/synthetic/jobs/123";
const s3 = "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com";
const bytes = Buffer.from("%PDF-synthetic-guard-fixture");
const fileUrl = `${s3}/stash/applications/resumes/1700000000000-abc-fixture`;
const now = Date.parse("2026-09-16T12:00:00Z");
function loader() {
  return {
    urlToken: "synthetic",
    jobPostId: "123",
    submitPath: target,
    confirmationPath: "/synthetic/jobs/123/confirmation",
    jobPost: {
      title: "Synthetic Analyst",
      fingerprint: "synthetic-fingerprint",
      post_type: "job_post",
      redirect_to: null,
      public_url: posting,
      education_config: {},
      questions: [
        ...["first_name", "last_name", "email", "phone"].map((name) => ({
          required: true,
          fields: [{ name, type: "input_text" }],
        })),
        {
          required: true,
          fields: [
            { name: "resume", type: "input_file" },
            { name: "resume_text", type: "textarea" },
          ],
        },
        {
          required: true,
          fields: [
            {
              name: "question_42",
              type: "multi_value_single_select",
              values: [
                { label: "Yes", value: 1 },
                { label: "No", value: 0 },
              ],
            },
          ],
        },
      ],
    },
  };
}
function fixture() {
  const identity = parseGreenhouseIdentity(posting, loader(), "greenhouse:synthetic:123");
  const context: GreenhouseFinalContext = {
    fields: {
      first_name: "Synthetic",
      last_name: "Applicant",
      email: "synthetic@example.test",
      phone: "+1 (202) 555-0123",
      question_42: true,
    },
    uploads: [
      {
        fieldName: "resume",
        name: "resume.pdf",
        sha256: hash(bytes),
        url: fileUrl,
        completed: true,
      },
    ],
    timeZone: "America/New_York",
  };
  const body = {
    fingerprint: "synthetic-fingerprint",
    "g-recaptcha-enterprise-token": "synthetic-assessment",
    job_application: {
      first_name: "Synthetic",
      last_name: "Applicant",
      email: "synthetic@example.test",
      phone: "+12025550123",
      answers_attributes: { "42": { question_id: "42", priority: 0, boolean_value: 1 } },
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
      educations: [
        {
          school_name_id: null,
          degree_id: null,
          discipline_id: null,
          start_date: { month: null, year: null },
          end_date: { month: null, year: null },
        },
      ],
      resume_url: fileUrl,
      resume_url_filename: "resume.pdf",
      mapped_url_token: null,
      appcast_click_id: null,
      time_zone: "America/New_York",
    },
  };
  return { identity, context, body };
}
function signed() {
  const fields = {
    "x-amz-server-side-encryption": "AES256",
    success_action_status: "201",
    "x-amz-credential": "synthetic/20260916/us-east-1/s3/aws4_request",
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    "x-amz-date": "20260916T120000Z",
    "x-amz-signature": "a".repeat(64),
    policy: "",
  };
  fields.policy = Buffer.from(
    JSON.stringify({
      expiration: "2026-09-16T13:00:00Z",
      conditions: [
        { bucket: "grnhse-prod-jben-us-east-1" },
        ["starts-with", "$key", "stash/applications/resumes"],
        ["content-length-range", 1, 104857600],
        ...Object.entries(fields)
          .filter(([k]) => !["policy", "x-amz-signature"].includes(k))
          .map(([k, v]) => ({ [k]: v })),
      ],
    }),
  ).toString("base64");
  const response = {
    url: s3,
    resume: { fields, key: "stash/applications/resumes/{timestamp}-{unique_id}-fixture" },
  };
  const request =
    "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=resume";
  return { response, request };
}
function multipart(
  fields: Record<string, string>,
  file = bytes,
  name = "resume.pdf",
  extra: [string, string][] = [],
) {
  const boundary = "----synthetic-boundary";
  const parts: Buffer[] = [];
  for (const [key, value] of [...Object.entries(fields), ...extra])
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { type: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

describe("Greenhouse scoped loader", () => {
  test("binds actual URL, loader post and declared endpoints", () => {
    const { identity } = fixture();
    expect(identity.targetUrl).toBe(target);
    expect(identity.choices.question_42).toHaveLength(2);
    expect(() =>
      parseGreenhouseIdentity(
        posting,
        { "routes/$url_token_.jobs_.$job_post_id": loader() },
        "greenhouse:synthetic:123",
      ),
    ).not.toThrow();
  });
  test.each([
    "http://job-boards.greenhouse.io/synthetic/jobs/123",
    "https://job-boards.greenhouse.io.evil.test/synthetic/jobs/123",
    `${posting}?email=synthetic@example.test`,
    `${posting}?gh_jid=456`,
    `${posting}#other`,
  ])("rejects URL outside frozen scope: %s", (value) => {
    expect(() => parseGreenhouseIdentity(value, loader(), "greenhouse:synthetic:123")).toThrow();
  });
  test("rejects target substitution, redirect, duplicate fields and ambiguous choices", () => {
    const a = loader();
    a.submitPath = "https://evil.test/submit";
    expect(() => parseGreenhouseIdentity(posting, a, "greenhouse:synthetic:123")).toThrow();
    const b = loader();
    b.jobPost.questions.push(b.jobPost.questions[0]!);
    expect(() => parseGreenhouseIdentity(posting, b, "greenhouse:synthetic:123")).toThrow();
    const c = loader();
    const field = c.jobPost.questions.at(-1)!.fields[0]!;
    if ("values" in field) field.values.push({ label: "Yes", value: 2 });
    expect(() => parseGreenhouseIdentity(posting, c, "greenhouse:synthetic:123")).toThrow();
  });
});

describe("Greenhouse signed upload guard", () => {
  function prepared() {
    const { response, request } = signed();
    const grant = validateGreenhousePresign(request, response, ["resume"], now).resume!;
    const form = multipart({
      ...grant.fields,
      utf8: "✓",
      key: "stash/applications/resumes/1700000000000-abc-fixture",
      authenticity_token: "1234",
      "Content-Type": "application/octet-stream",
    });
    return {
      grant,
      form,
      expected: { fieldName: "resume", name: "resume.pdf", sha256: hash(bytes) },
    };
  }
  test("binds signed metadata and exact frozen bytes", () => {
    const { grant, form, expected } = prepared();
    expect(validateGreenhouseUpload(form.type, form.body, grant, expected, now)).toEqual({
      url: fileUrl,
      key: "stash/applications/resumes/1700000000000-abc-fixture",
      sha256: hash(bytes),
      bytes: bytes.length,
    });
  });
  test("rejects foreign S3, stale policy, unobserved field and extra signed metadata", () => {
    const { response, request } = signed();
    expect(() =>
      validateGreenhousePresign(
        request,
        { ...response, url: "https://evil.s3.amazonaws.com" },
        ["resume"],
        now,
      ),
    ).toThrow();
    expect(() => validateGreenhousePresign(request, response, ["cover_letter"], now)).toThrow();
    expect(() =>
      validateGreenhousePresign(request, response, ["resume"], now + 4_000_000),
    ).toThrow();
    expect(() =>
      validateGreenhousePresign(`${request}&other=x`, response, ["resume"], now),
    ).toThrow();
    response.resume.fields = { ...response.resume.fields, ...{ unapproved: "secret" } };
    expect(() => validateGreenhousePresign(request, response, ["resume"], now)).toThrow();
  });
  test("rejects duplicate part, wrong bytes/name, key escape and missing terminator", () => {
    const { grant, form, expected } = prepared();
    for (const changed of [
      multipart(
        {
          ...grant.fields,
          utf8: "✓",
          key: "stash/applications/resumes/1700000000000-abc-fixture",
          authenticity_token: "1234",
          "Content-Type": "application/octet-stream",
        },
        bytes,
        "resume.pdf",
        [["key", "other"]],
      ),
      {
        ...form,
        body: Buffer.from(form.body.toString().replace("%PDF-synthetic", "%PDF-tampered")),
      },
      {
        ...form,
        body: Buffer.from(
          form.body.toString().replace('filename="resume.pdf"', 'filename="other.pdf"'),
        ),
      },
      {
        ...form,
        body: Buffer.from(form.body.toString().replace("1700000000000-abc-fixture", "../escape")),
      },
      { ...form, body: form.body.subarray(0, form.body.length - 4) },
    ])
      expect(() =>
        validateGreenhouseUpload(changed.type, changed.body, grant, expected, now),
      ).toThrow();
  });
});

describe("Greenhouse final application guard", () => {
  test("accepts only the complete approved body and returns stable application hash", () => {
    const { identity, context, body } = fixture();
    const result = validateGreenhouseFinalRequest(
      Buffer.from(JSON.stringify(body)),
      identity,
      context,
    );
    expect(result.requestBodyHash).toBe(hash(JSON.stringify(body)));
    expect(result.applicationPayloadHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test("rejects extra envelope/application claims, changed answer, file URL and timezone", () => {
    for (const mutate of [
      (b: Record<string, unknown>) => {
        b.request_token = "unapproved";
      },
      (b: Record<string, unknown>) => {
        (b.job_application as Record<string, unknown>).secret = "canary";
      },
      (b: Record<string, unknown>) => {
        (b.job_application as Record<string, unknown>).email = "other@example.test";
      },
      (b: Record<string, unknown>) => {
        (b.job_application as Record<string, unknown>).resume_url = "https://evil.test/resume";
      },
      (b: Record<string, unknown>) => {
        (b.job_application as Record<string, unknown>).time_zone = "Europe/London";
      },
    ]) {
      const { identity, context, body } = fixture();
      mutate(body);
      expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
    }
  });
  test("does not accept unfilled required fields or incomplete staging", () => {
    const { identity, context, body } = fixture();
    delete context.fields.question_42;
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
    const other = fixture();
    other.context.uploads[0]!.completed = false;
    expect(() =>
      validateGreenhouseFinalRequest(other.body, other.identity, other.context),
    ).toThrow();
  });
  test("normalizes only exact approved phone digits with explicit dialing proof", () => {
    const { identity, context, body } = fixture();
    context.fields.phone = "(202) 555-0123";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
    context.phoneCountryDialCode = "1";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    body.job_application.phone = "+12025550124";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("rejects arbitrary coordinates and additional unapproved data", () => {
    const { identity, context, body } = fixture();
    context.fields.candidate_location = "Synthetic City";
    context.location = {
      label: "Other City",
      latitude: "1",
      longitude: "2",
      countryShortName: "US",
    };
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("rejects duplicate JSON keys and bytes discarded during parsing", () => {
    const { identity, context, body } = fixture();
    const serialized = JSON.stringify(body);
    const hidden = serialized.replace(
      '"email":"synthetic@example.test"',
      '"email":"PRIVATE_CANARY","email":"synthetic@example.test"',
    );
    expect(() => validateGreenhouseFinalRequest(hidden, identity, context)).toThrow();
    expect(() => validateGreenhouseFinalRequest(Buffer.from(hidden), identity, context)).toThrow();
    expect(() =>
      validateGreenhouseFinalRequest(JSON.stringify(body, null, 2), identity, context),
    ).toThrow();
  });
  test("binds numeric option IDs to an exact approved choice", () => {
    const { identity, context, body } = fixture();
    identity.choices.question_42 = [{ label: "Synthetic choice", value: "12345" }];
    context.fields.question_42 = "Synthetic choice";
    const app = body.job_application as Record<string, unknown>;
    app.answers_attributes = {
      "42": {
        question_id: "42",
        priority: 0,
        answer_selected_options_attributes: { "0": { question_option_id: 12345 } },
      },
    };
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    app.answers_attributes = {
      "42": {
        question_id: "42",
        priority: 0,
        answer_selected_options_attributes: { "0": { question_option_id: 12346 } },
      },
    };
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("binds required education to approved labels and scoped observed IDs", () => {
    const { identity, context, body } = fixture();
    identity.educationConfig = {
      school_name: "required",
      degree: "required",
      end_month: "required",
      end_year: "required",
    };
    Object.assign(context.fields, {
      school_name: "Synthetic University",
      degree: "Synthetic Degree",
      end_month: "May",
      end_year: "2028",
    });
    context.selections = {
      school_name: { label: "Synthetic University", value: "10" },
      degree: { label: "Synthetic Degree", value: "20" },
      end_month: { label: "May", value: "5" },
    };
    const app = body.job_application as Record<string, unknown>;
    app.educations = [
      {
        school_name_id: "10",
        degree_id: "20",
        discipline_id: null,
        start_date: { month: null, year: null },
        end_date: { month: 5, year: "2028" },
      },
    ];
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    context.selections.school_name!.label = "Unapproved University";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("requires exact separate user continuation code, never token and code together", () => {
    const { identity, context, body } = fixture();
    const next: Record<string, unknown> = { ...body, security_code: "ABCD1234" };
    delete next["g-recaptcha-enterprise-token"];
    expect(() => validateGreenhouseFinalRequest(next, identity, context)).toThrow();
    context.continuation = { securityCode: "ABCD1234" };
    expect(() => validateGreenhouseFinalRequest(next, identity, context)).not.toThrow();
    next["g-recaptcha-enterprise-token"] = "synthetic";
    expect(() => validateGreenhouseFinalRequest(next, identity, context)).toThrow();
  });
});

describe("Greenhouse response evidence", () => {
  test.each([
    "captcha-failed",
    "captcha-retry",
    "invalid-security-code",
    "expired-security-code",
    "security-code-error",
  ])("classifies %s without copying recipient/message", (code) => {
    expect(
      classifyGreenhouseResponse(422, {
        code,
        message: "PRIVATE_CANARY",
        security_code_recipient: "synthetic@example.test",
      }),
    ).toEqual({ kind: "challenge", code });
    expect(classifyGreenhouseResponse(200, { code })).toEqual({ kind: "uncertain" });
  });
  test("malformed success, redirects and unknown errors stay uncertain", () => {
    for (const body of ["<html>Login</html>", "bad-json", "null", "[]", '{"error":false}'])
      expect(classifyGreenhouseResponse(200, body).kind).toBe("uncertain");
    expect(classifyGreenhouseResponse(302, "").kind).toBe("uncertain");
    expect(classifyGreenhouseResponse(500, { code: "captcha-failed" }).kind).toBe("uncertain");
    expect(classifyGreenhouseResponse(200, "{}").kind).toBe("accepted");
    expect(classifyGreenhouseResponse(204, "").kind).toBe("accepted");
  });
  test("public confirmation needs the same exact POST receipt and hashes", () => {
    const { identity, context, body } = fixture();
    const hashes = validateGreenhouseFinalRequest(body, identity, context);
    const receipt = { ...hashes, targetUrl: target, responseStatus: 200, responseBody: "{}" };
    const confirmation = `https://job-boards.greenhouse.io${identity.confirmationPath}`;
    expect(isGreenhouseConfirmationEvidence(identity, receipt, confirmation, hashes)).toBe(true);
    expect(
      isGreenhouseConfirmationEvidence(
        identity,
        { ...receipt, requestBodyHash: hash("other") },
        confirmation,
        hashes,
      ),
    ).toBe(false);
    expect(
      isGreenhouseConfirmationEvidence(
        identity,
        { ...receipt, responseBody: "<html>login</html>" },
        confirmation,
        hashes,
      ),
    ).toBe(false);
    expect(
      isGreenhouseConfirmationEvidence(identity, receipt, "https://evil.test/confirmation", hashes),
    ).toBe(false);
  });
});

// Public loader shapes captured by GET on 2026-09-16. Descriptions, tracking,
// fingerprints and unrelated choices are omitted. Every applicant value is synthetic.
// Protocol oracle: entry.client-B5kjVA5a.js.map, build_application.ts:77-111,
// 177-255,257-278,352-387. These expected payloads do not call the production builder.
function publicShapeFixture(board: "gardacp" | "robinhood") {
  const garda = board === "gardacp";
  const postId = garda ? "6163540004" : "8198187";
  const actualUrl = `https://job-boards.greenhouse.io/${board}/jobs/${postId}`;
  const choice = (value: number, label: string) => ({ value, label });
  const questions: {
    required: boolean;
    fields: { name: string; type: string; values?: { value: number; label: string }[] }[];
  }[] = [
    ...["first_name", "last_name", "email", "phone", "candidate_location"].map((name) => ({
      required: true,
      fields: [{ name, type: "input_text" }],
    })),
    {
      required: true,
      fields: [
        { name: "resume", type: "input_file" },
        { name: "resume_text", type: "textarea" },
      ],
    },
  ];
  if (garda)
    questions.push({
      required: true,
      fields: [
        { name: "cover_letter", type: "input_file" },
        { name: "cover_letter_text", type: "textarea" },
      ],
    });
  const textQuestion = (name: string, required: boolean) => ({
    required,
    fields: [{ name, type: "input_text" }],
  });
  const selectQuestion = (name: string, values: { value: number; label: string }[]) => ({
    required: true,
    fields: [{ name, type: "multi_value_single_select", values }],
  });
  if (garda)
    questions.push(
      textQuestion("question_19679099004", false),
      textQuestion("question_19679100004", false),
      textQuestion("question_19679101004", true),
      textQuestion("question_19679102004", true),
    );
  else
    questions.push(
      textQuestion("question_69154673", false),
      selectQuestion("question_69154676", [choice(751328386, "I have never worked at Robinhood")]),
      selectQuestion("question_69154674", [choice(1, "Yes"), choice(0, "No")]),
      selectQuestion("question_69154675", [choice(1, "Yes"), choice(0, "No")]),
      selectQuestion("question_69154678", [choice(751328387, "Yes"), choice(751328388, "No")]),
      textQuestion("question_69154679", false),
      selectQuestion("question_69154680", [choice(751328389, "Yes"), choice(751328390, "No")]),
      textQuestion("question_69154681", false),
    );
  const declines = [
    [1255, 7045],
    [1258, 7063],
    [1259, 7067],
    [1261, 7073],
  ] as const;
  const education = Object.fromEntries(
    [
      "school_name",
      "degree",
      "discipline",
      "start_month",
      "start_year",
      "end_month",
      "end_year",
    ].map((key) => [
      key,
      !garda && ["school_name", "degree", "end_month", "end_year"].includes(key)
        ? "required"
        : "hidden",
    ]),
  );
  const rawLoader = {
    urlToken: board,
    jobPostId: postId,
    submitPath: `https://boards.greenhouse.io/${board}/jobs/${postId}`,
    confirmationPath: `/${board}/jobs/${postId}/confirmation`,
    jobPost: {
      post_type: "job_post",
      redirect_to: null,
      title: garda ? "Trading Analyst Intern, Credit " : "Investment Analyst Intern (Summer 2027)",
      public_url: garda
        ? actualUrl
        : `https://boards.greenhouse.io/${board}/jobs/${postId}?t=gh_src=&gh_jid=${postId}`,
      fingerprint: "synthetic-public-shape-fingerprint",
      questions,
      education_config: education,
      data_compliance: garda
        ? null
        : {
            type: "gdpr",
            requires_processing_consent: false,
            requires_retention_consent: false,
            retention_period: null,
            demographic_data_consent_applies: true,
            single_purpose_consent: true,
          },
      demographic_questions: garda
        ? null
        : {
            questions: [
              ...declines.map(([id, optionId]) => ({
                id,
                required: true,
                answer_type: { key: "SINGLE_SELECT" },
                answer_options: [
                  {
                    id: optionId,
                    name: "I don't wish to answer",
                    free_form: false,
                    decline_to_answer: true,
                  },
                ],
              })),
              {
                id: 1465,
                required: false,
                answer_type: { key: "SINGLE_SELECT" },
                answer_options: [
                  {
                    id: 8294,
                    name: "I don't wish to answer",
                    free_form: false,
                    decline_to_answer: false,
                  },
                ],
              },
            ],
          },
    },
  };
  const identity = parseGreenhouseIdentity(actualUrl, rawLoader, `greenhouse:${board}:${postId}`);
  const original = fixture();
  const context: GreenhouseFinalContext = {
    ...original.context,
    fields: {
      first_name: "Synthetic",
      last_name: "Applicant",
      email: "synthetic@example.test",
      phone: "(202) 555-0123",
      country: "United States +1",
      candidate_location: "Synthetic City, Synthetic Region, United States",
    },
    phoneCountryDialCode: "1",
    location: {
      label: "Synthetic City, Synthetic Region, United States",
      latitude: "1",
      longitude: "2",
      countryShortName: "US",
    },
  };
  const application: Record<string, unknown> = {
    ...original.body.job_application,
    location: context.location!.label,
    latitude: "1",
    longitude: "2",
    country_short_name: "US",
    answers_attributes: {},
  };
  if (garda) {
    Object.assign(context.fields, { question_19679101004: "Yes", question_19679102004: "No" });
    const cover = {
      fieldName: "cover_letter",
      name: "cover-letter.pdf",
      sha256: hash("synthetic-cover-letter"),
      url: `${s3}/stash/applications/resumes/1700000000000-abc-cover`,
      completed: true,
    };
    context.uploads = [...context.uploads, cover];
    Object.assign(application, {
      cover_letter_url: cover.url,
      cover_letter_url_filename: cover.name,
      answers_attributes: {
        "19679099004": { question_id: "19679099004", priority: 0 },
        "19679100004": { question_id: "19679100004", priority: 1 },
        "19679101004": { question_id: "19679101004", priority: 2, text_value: "Yes" },
        "19679102004": { question_id: "19679102004", priority: 3, text_value: "No" },
      },
    });
  } else {
    Object.assign(context.fields, {
      question_69154676: "I have never worked at Robinhood",
      question_69154674: "Yes",
      question_69154675: "No",
      question_69154678: "No",
      question_69154680: "No",
      school_name: "Synthetic University",
      degree: "Synthetic Degree",
      end_month: "May",
      end_year: "2028",
    });
    for (const [id] of declines) context.fields[`demographic_${id}`] = "I don't wish to answer";
    context.selections = {
      school_name: { label: "Synthetic University", value: "10" },
      degree: { label: "Synthetic Degree", value: "20" },
      end_month: { label: "May", value: "5" },
    };
    const option = (questionId: string, priority: number, optionId: number) => ({
      question_id: questionId,
      priority,
      answer_selected_options_attributes: { "0": { question_option_id: optionId } },
    });
    Object.assign(application, {
      answers_attributes: {
        "69154673": { question_id: "69154673", priority: 0 },
        "69154676": option("69154676", 1, 751328386),
        "69154674": { question_id: "69154674", priority: 2, boolean_value: 1 },
        "69154675": { question_id: "69154675", priority: 3, boolean_value: 0 },
        "69154678": option("69154678", 4, 751328388),
        "69154679": { question_id: "69154679", priority: 5 },
        "69154680": option("69154680", 6, 751328390),
        "69154681": { question_id: "69154681", priority: 7 },
      },
      educations: [
        {
          school_name_id: "10",
          degree_id: "20",
          discipline_id: null,
          start_date: { month: null, year: null },
          end_date: { month: 5, year: "2028" },
        },
      ],
      demographic_answers: declines.map(([id, optionId]) => ({
        question_id: id,
        answer_options: [{ answer_option_id: String(optionId) }],
      })),
      data_compliance: { gdpr_demographic_data_consent_given: false },
    });
  }
  return {
    identity,
    context,
    body: {
      fingerprint: identity.fingerprint,
      "g-recaptcha-enterprise-token": "synthetic-assessment",
      job_application: application,
    },
    rawLoader,
    actualUrl,
  };
}

describe("Public Garda and Robinhood loader shapes with synthetic applicant values", () => {
  test("English loader month labels map to published numeric values without hidden inputs", () => {
    const { rawLoader, actualUrl, context, body } = publicShapeFixture("robinhood");
    const identity = parseGreenhouseIdentity(
      actualUrl,
      { root: { locale: "en" }, "routes/$url_token_.jobs_.$job_post_id": rawLoader },
      "greenhouse:robinhood:8198187",
    );
    delete context.selections!.end_month;
    expect(identity.choices.end_month).toHaveLength(12);
    expect(identity.choices.end_month![4]).toEqual({ label: "May", value: "5" });
    expect(identity.choices.start_month).toBeUndefined();
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    context.fields.end_month = "June";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("does not assume English month labels for a different or missing locale", () => {
    for (const locale of ["fr", undefined]) {
      const { rawLoader, actualUrl, context, body } = publicShapeFixture("robinhood");
      const identity = parseGreenhouseIdentity(
        actualUrl,
        { root: { locale }, "routes/$url_token_.jobs_.$job_post_id": rawLoader },
        "greenhouse:robinhood:8198187",
      );
      delete context.selections!.end_month;
      expect(identity.choices.end_month).toBeUndefined();
      expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
    }
  });
  test.each([
    "gardacp",
    "robinhood",
  ] as const)("matches published application defaults/order/types for %s", (board) => {
    const { identity, context, body } = publicShapeFixture(board);
    expect(() =>
      validateGreenhouseFinalRequest(Buffer.from(JSON.stringify(body)), identity, context),
    ).not.toThrow();
    expect(body.job_application).not.toHaveProperty("candidate_location");
    expect(body.job_application.phone).toBe("+12025550123");
    expect(body.job_application).not.toHaveProperty("resume_text");
    expect(body.job_application).not.toHaveProperty("cover_letter_text");
  });
  test("Garda unanswered optional text keeps question identity/priority but omits text_value", () => {
    const { identity, context, body } = publicShapeFixture("gardacp");
    const answers = body.job_application.answers_attributes as Record<
      string,
      Record<string, unknown>
    >;
    expect(answers["19679099004"]).toEqual({ question_id: "19679099004", priority: 0 });
    expect(answers["19679100004"]).toEqual({ question_id: "19679100004", priority: 1 });
    delete answers["19679099004"];
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("explicitly cleared optional text is empty, not absent", () => {
    const { identity, context, body } = publicShapeFixture("gardacp");
    context.fields.question_19679099004 = "";
    const answers = body.job_application.answers_attributes as Record<
      string,
      Record<string, unknown>
    >;
    answers["19679099004"]!.text_value = "";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    delete answers["19679099004"]!.text_value;
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("hidden Garda education/employment still use one null default record", () => {
    const { identity, context, body } = publicShapeFixture("gardacp");
    expect(body.job_application.educations).toEqual([
      {
        school_name_id: null,
        degree_id: null,
        discipline_id: null,
        start_date: { month: null, year: null },
        end_date: { month: null, year: null },
      },
    ]);
    expect(body.job_application.employments).toEqual([
      {
        start_date: { month: null, year: null },
        end_date: { month: null, year: null },
        current: false,
      },
    ]);
    body.job_application.educations = [];
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("Robinhood preserves source order rather than numeric question order", () => {
    const { identity, context, body } = publicShapeFixture("robinhood");
    const answers = body.job_application.answers_attributes as Record<
      string,
      Record<string, unknown>
    >;
    expect(answers["69154676"]!.priority).toBe(1);
    expect(answers["69154674"]!.priority).toBe(2);
    expect(answers["69154678"]!.answer_selected_options_attributes).toEqual({
      "0": { question_option_id: 751328388 },
    });
    answers["69154676"]!.priority = 3;
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("Robinhood required demographic decline is allowed only when explicitly frozen", () => {
    const { identity, context, body } = publicShapeFixture("robinhood");
    expect(identity.choices.demographic_1255).toEqual([
      { label: "I don't wish to answer", value: "7045" },
    ]);
    expect(identity.choices.demographic_1465).toEqual([]);
    expect((body.job_application.demographic_answers as unknown[]).length).toBe(4);
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    context.fields.demographic_1255 = "7045";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).not.toThrow();
    delete context.fields.demographic_1255;
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("never infers a demographic choice, freeform response or unmarked decline", () => {
    for (const value of ["Cisgender man", "7039", "PRIVATE_CANARY"]) {
      const { identity, context, body } = publicShapeFixture("robinhood");
      context.fields.demographic_1255 = value;
      expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
    }
    const { identity, context, body } = publicShapeFixture("robinhood");
    context.fields.demographic_1465 = "I don't wish to answer";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
    delete context.fields.demographic_1465;
    const answers = body.job_application.demographic_answers as {
      answer_options: Record<string, unknown>[];
    }[];
    answers[0]!.answer_options[0]!.text = "PRIVATE_CANARY";
    expect(() => validateGreenhouseFinalRequest(body, identity, context)).toThrow();
  });
  test("rejects invalid demographic metadata and source-marked freeform decline", () => {
    const { rawLoader, actualUrl } = publicShapeFixture("robinhood");
    rawLoader.jobPost.demographic_questions!.questions[0]!.answer_options[0]!.free_form = true;
    const identity = parseGreenhouseIdentity(actualUrl, rawLoader, "greenhouse:robinhood:8198187");
    expect(identity.choices.demographic_1255).toEqual([]);
    rawLoader.jobPost.demographic_questions!.questions.push(
      rawLoader.jobPost.demographic_questions!.questions[0]!,
    );
    expect(() =>
      parseGreenhouseIdentity(actualUrl, rawLoader, "greenhouse:robinhood:8198187"),
    ).toThrow();
  });
});
