import { z } from "zod/v4";
import { resumeDataSchema } from "./resume";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const filename = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const operation = z.enum([
  "capabilities",
  "discover_jobs",
  "render_resume",
  "verify_document",
  "export_resume_yaml",
  "import_resume_yaml",
]);
const base = { protocolVersion: z.literal(1), requestId: z.string().min(1).max(128) };
const resumePayload = z.object({ resume: resumeDataSchema }).strict();
const diagnostic = z.object({ code: z.string(), message: z.string() }).strict();
const diagnosticList = z.array(diagnostic).max(100);
const request = <N extends z.infer<typeof operation>, T extends z.ZodRawShape>(name: N, shape: T) =>
  z.object({ ...base, operation: z.literal(name), payload: z.object(shape).strict() }).strict();

export const personalLocalToolsRequestSchema = z.union([
  request("capabilities", {}),
  request("discover_jobs", {
    board: z.enum(["linkedin", "indeed", "google"]),
    query: z.string().min(1).max(200),
    location: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(20),
  }),
  request("render_resume", {
    ...resumePayload.shape,
    renderer: z.literal("rendercv-classic"),
    maxPages: z.union([z.literal(1), z.literal(2)]),
  }),
  request("verify_document", {
    filename,
    sha256: hash,
    requiredText: z.array(z.string().min(1).max(1000)).max(100),
    supportedTerms: z.array(z.string().min(1).max(200)).max(200),
    maxPages: z.union([z.literal(1), z.literal(2)]),
    renderer: z.string().min(1).max(80),
  }),
  request("export_resume_yaml", resumePayload.shape),
  request("import_resume_yaml", {
    bundleYaml: z.string().min(1).max(1_000_000),
    expectedResume: resumeDataSchema,
  }),
]);

const lead = z
  .object({
    source: z.enum(["linkedin", "indeed", "google"]),
    sourceRowId: z.string().min(1),
    originalUrl: z.url(),
    candidateDestinationUrl: z.url().nullable(),
    titleHint: z.string().min(1),
    companyHint: z.string().nullable(),
    locationHint: z.string().nullable(),
    postedAt: z.string().nullable(),
    discoveredAt: z.string(),
    responseSha256: hash,
    resolutionStatus: z.literal("unresolved"),
  })
  .strict();
const discovery = z
  .object({
    board: z.enum(["linkedin", "indeed", "google"]),
    status: z.enum(["complete", "empty", "partial", "blocked", "error"]),
    leads: z.array(lead).max(20),
    snapshotFilename: filename.nullable(),
    responseSha256: hash.nullable(),
    cooldownSeconds: z.number().int().nonnegative().nullable(),
    diagnostics: diagnosticList,
  })
  .strict();
export const personalDocumentVerificationSchema = z
  .object({
    status: z.enum(["passed", "failed", "unavailable"]),
    artifactSha256: hash,
    verifierVersion: z.literal("1"),
    verifierConfigHash: hash.optional(),
    renderer: z.string(),
    pageCount: z.number().int().nonnegative().nullable(),
    extractedCharacters: z.number().int().nonnegative(),
    checks: z
      .array(
        z
          .object({
            code: z.string(),
            status: z.enum(["passed", "failed", "unavailable"]),
            message: z.string(),
          })
          .strict(),
      )
      .max(310),
  })
  .strict()
  .superRefine((report, context) => {
    const required = [
      "artifact_hash",
      "page_limit",
      "text_layer",
      "glyphs",
      "renderer_margins",
      "layout_bounds",
    ];
    if (report.status !== "passed") return;
    if (
      report.checks.some((check) => check.status !== "passed") ||
      required.some((code) => !report.checks.some((check) => check.code === code)) ||
      new Set(report.checks.map((check) => check.code)).size !== report.checks.length ||
      report.pageCount === null ||
      report.pageCount < 1 ||
      report.pageCount > 2 ||
      report.extractedCharacters < 60
    )
      context.addIssue({
        code: "custom",
        message: "A passed verification must contain all successful bounded document checks",
      });
  });
const rendered = z
  .object({
    filename,
    sha256: hash,
    sizeBytes: z.number().int().positive(),
    pageCount: z.number().int().positive(),
    renderer: z.literal("rendercv-classic"),
    rendererVersion: z.string(),
    configSha256: hash,
    sourceSha256: hash,
    mappingFilename: filename,
    diagnostics: diagnosticList,
  })
  .strict();
const exported = z
  .object({
    bundleYaml: z.string().max(1_000_000),
    sourceSha256: hash,
    configSha256: hash,
    rendererVersion: z.string(),
  })
  .strict();
const imported = z
  .object({
    sourceSha256: hash,
    requiresIndependentReview: z.literal(true),
    operations: z
      .array(
        z
          .object({
            kind: z.enum(["cut", "reorder", "rephrase"]),
            path: z.string(),
            before: z.unknown(),
            after: z.unknown(),
          })
          .strict(),
      )
      .max(1000),
    diagnostics: diagnosticList,
  })
  .strict();
const capabilities = z
  .object({
    operations: z.array(operation),
    components: z.record(z.string(), z.string()),
    verifierVersion: z.literal("1"),
  })
  .strict();
const success = <N extends z.infer<typeof operation>, T extends z.ZodType>(name: N, result: T) =>
  z.object({ ...base, operation: z.literal(name), status: z.literal("ok"), result }).strict();

export const personalLocalToolsResponseSchema = z.union([
  success("capabilities", capabilities),
  success("discover_jobs", discovery),
  success("render_resume", rendered),
  success("verify_document", personalDocumentVerificationSchema),
  success("export_resume_yaml", exported),
  success("import_resume_yaml", imported),
  z
    .object({
      ...base,
      operation,
      status: z.literal("error"),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

export type PersonalLocalToolsRequest = z.infer<typeof personalLocalToolsRequestSchema>;
export type PersonalLocalToolsResponse = z.infer<typeof personalLocalToolsResponseSchema>;

export type PersonalDocumentVerification = z.infer<typeof personalDocumentVerificationSchema>;
