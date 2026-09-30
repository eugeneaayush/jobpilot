import { z } from "zod/v4";

const providerSchema = z.object({
  id: z.enum(["codex", "claude"]),
  installed: z.boolean(),
  version: z.string().max(256).nullable(),
});
const personalTerminalReadinessSchema = z.object({
  status: z.enum(["available", "unavailable", "needs_auth"]),
  checkedAt: z.date(),
  structuredTasks: z.boolean(),
  mock: z.boolean(),
  brokerConfigured: z.boolean(),
  codexSupervisorEnabled: z.boolean(),
  providerApproved: z.boolean(),
  providerApprovalScope: z.enum(["metadata_only", "applicant_data"]).nullable(),
  providerApprovalBlockReason: z.string().nullable(),
  providers: z.array(providerSchema),
  blockReason: z.string().nullable(),
});
export const personalReadinessSchema = z.object({
  checkedAt: z.date(),
  personalMode: z.boolean(),
  providerApproval: z.object({
    approved: z.boolean(),
    scope: z.enum(["none", "metadata_only", "applicant_data"]),
  }),
  resume: z.object({
    status: z.enum(["missing", "conflicted", "ready"]),
    evidenceId: z.uuid().nullable(),
    sourceHash: z.string().nullable(),
    conflicts: z.array(z.string()),
  }),
  terminal: personalTerminalReadinessSchema,
  browser: z.object({ status: z.literal("needs_per_job"), reason: z.string() }),
  missingSettings: z.array(
    z.object({ field: z.string(), scope: z.enum(["campaign", "per_job"]), reason: z.string() }),
  ),
  blockers: z.array(z.string()),
  campaignExecutionReady: z.boolean(),
});
const pointer = z
  .string()
  .regex(/^(\/(?:[^~]|~[01])*)+$/)
  .max(1000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const personalScreeningValueSchema = z.union([
  z.string().max(10000),
  z.boolean(),
  z
    .array(
      z
        .string()
        .min(1)
        .max(1000)
        .refine((value) => value.trim().length > 0),
    )
    .max(50)
    .refine((values) => new Set(values).size === values.length, "Selection values must be unique"),
]);
const personalScreeningAnswerSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,150}$/),
  value: personalScreeningValueSchema,
  fieldName: z.string().min(1).max(300).optional(),
  label: z.string().min(1).max(1000).optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("explicit_user"), confirmed: z.literal(true) }),
    z.object({
      kind: z.literal("delegated_preference"),
      preference: z.literal("decline_voluntary_demographics"),
    }),
    z.object({ kind: z.literal("settings"), settingsHash: hash, pointer }),
    z.object({ kind: z.literal("resume"), evidenceId: z.uuid(), sourceHash: hash, pointer }),
    z
      .object({
        kind: z.literal("resume_normalized"),
        evidenceId: z.uuid(),
        sourceHash: hash,
        pointer,
        transformation: z.enum([
          "mba_degree_without_candidate",
          "cbs_parent_university",
          "education_end_month",
          "education_end_year",
          "us_city_state_label",
          "phone_country_label",
        ]),
        countryPointer: pointer.optional(),
      })
      .superRefine((source, context) => {
        if (
          (source.transformation === "phone_country_label") !==
          (source.countryPointer !== undefined)
        )
          context.addIssue({
            code: "custom",
            path: ["countryPointer"],
            message: "Only phone country normalization requires a corroborating country pointer",
          });
      }),
  ]),
});
export const personalScreeningAnswersInputSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime(),
    answers: z.array(personalScreeningAnswerSchema).max(100),
  })
  .refine(
    (value) => new Set(value.answers.map((answer) => answer.key)).size === value.answers.length,
    "Answer keys must be unique",
  );
export const personalScreeningSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  recordId: z.uuid(),
  identity: z.string(),
  postingContentHash: z.string(),
  settingsHash: hash,
  createdAt: z.string(),
  snapshotHash: hash,
  answers: z.array(personalScreeningAnswerSchema),
});
const personalScreeningSuggestionSchema = z.object({
  fieldName: z.string(),
  category: z.enum([
    "authorization",
    "sponsorship",
    "skill_experience",
    "total_experience",
    "compensation",
    "relocation",
    "availability",
    "voluntary_demographic",
    "consent",
    "unknown",
  ]),
  answer: personalScreeningAnswerSchema.nullable(),
  reason: z.string(),
});
export const personalScreeningAnswersResponseSchema = z.object({
  suggestions: z.array(personalScreeningSuggestionSchema).optional(),
  recordId: z.uuid(),
  updatedAt: z.date(),
  snapshot: personalScreeningSnapshotSchema.nullable(),
  requiresPreview: z.boolean(),
  questions: z
    .array(
      z.object({
        fieldName: z.string().max(300),
        label: z.string().max(1000),
        type: z.string().max(40),
        required: z.boolean(),
        multiple: z.boolean().optional(),
        options: z
          .array(z.object({ value: z.string().max(1000), label: z.string().max(1000) }))
          .max(1000)
          .optional(),
      }),
    )
    .max(500),
});
export type PersonalReadiness = z.infer<typeof personalReadinessSchema>;
export type PersonalTerminalReadiness = z.infer<typeof personalTerminalReadinessSchema>;
export type PersonalScreeningAnswer = z.infer<typeof personalScreeningAnswerSchema>;
export type PersonalScreeningAnswersInput = z.infer<typeof personalScreeningAnswersInputSchema>;

export type PersonalScreeningSuggestion = z.infer<typeof personalScreeningSuggestionSchema>;
