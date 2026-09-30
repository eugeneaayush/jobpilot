import { z } from "zod/v4";
import { paginatedSchema, paginationQuerySchema } from "./pagination";
import { personalFitEvaluationSchema } from "./personal-fit";
import { personalDocumentVerificationSchema } from "./personal-local-tools";
import { personalSenioritySchema } from "./personal-seniority";

export const personalTrackSchema = z.enum([
  "mba_internship",
  "post_mba_fulltime",
  "general_professional",
]);
const personalStateSchema = z.enum([
  "discovered",
  "eligible",
  "prepared",
  "applying",
  "submitted",
  "blocked",
  "failed",
  "submission_uncertain",
]);
const personalPreviewSchema = z.object({
  mode: z.enum(["offline", "live_preview"]),
  pdfUrl: z.string(),
  pdfHash: z.string(),
  manifestHash: z.string(),
  readiness: z.enum(["draft", "ready"]),
  conflicts: z.array(z.string()),
  renderReviewed: z.boolean(),
});
export const personalRecordSchema = z.object({
  id: z.uuid(),
  campaignId: z.string().nullable(),
  identity: z.string(),
  title: z.string(),
  company: z.string(),
  url: z.string(),
  requisitionId: z.string().nullable(),
  track: personalTrackSchema,
  state: personalStateSchema,
  fitScore: z.number().nullable(),
  fitReasons: z.array(z.string()),
  fitEvaluation: personalFitEvaluationSchema.nullable().optional(),
  documentVerification: personalDocumentVerificationSchema.nullable().optional(),
  seniority: personalSenioritySchema.optional(),
  eligibility: z.object({
    decision: z.enum(["eligible", "ineligible", "unknown"]),
    reasons: z.array(z.string()),
  }),
  eligibilityFreshness: z
    .object({
      status: z.enum(["current", "stale", "unknown"]),
      reason: z.string().nullable(),
    })
    .optional(),
  missingAnswers: z.array(z.string()),
  preview: personalPreviewSchema.nullable(),
  updatedAt: z.date(),
});
export const personalQuerySchema = paginationQuerySchema.extend({
  track: personalTrackSchema.optional(),
});
export const personalDashboardSchema = z.object({
  records: paginatedSchema(personalRecordSchema),
  sources: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      status: z.enum(["complete", "partial", "failed", "blocked"]),
      count: z.number(),
      error: z.string().nullable(),
      createdAt: z.date(),
    }),
  ),
  resume: z
    .object({
      id: z.string(),
      label: z.string(),
      sourceHash: z.string(),
      conflicts: z.array(z.string()),
      createdAt: z.date(),
    })
    .nullable(),
  capabilities: z.object({
    personalMode: z.boolean(),
    offlinePreview: z.boolean(),
    liveSubmissions: z.boolean(),
    missingSetup: z.array(z.string()),
  }),
  activity: z
    .array(
      z.object({
        id: z.string(),
        recordId: z.string(),
        mode: z.string(),
        state: z.string(),
        updatedAt: z.date(),
      }),
    )
    .optional(),
  supervisor: z
    .object({ status: z.string(), updatedAt: z.string(), error: z.string().nullable() })
    .nullable()
    .optional(),
});
export const personalDiscoverSchema = z.object({
  campaignId: z.uuid().optional(),
  runId: z.uuid().optional(),
  boardToken: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  source: z.enum(["greenhouse", "lever", "ashby", "cbs"]).default("greenhouse"),
  region: z.enum(["global", "eu"]).optional(),
  importText: z.string().max(5_000_000).optional(),
  importFormat: z.enum(["csv", "json"]).optional(),
  sourceUrl: z.url().optional(),
  employer: z.string().max(200).optional(),
});
export const personalDiscoveryResponseSchema = z.object({
  campaignId: z.string(),
  runId: z.string(),
  count: z.number(),
  status: z.enum(["complete", "partial", "failed", "blocked"]),
  nextEligibleAt: z.string().nullable().optional(),
});
export const personalIntakeResponseSchema = z.object({
  resumeId: z.string(),
  sourceHash: z.string(),
  conflicts: z.array(z.string()),
});
export const personalReassessmentResponseSchema = z.object({
  evaluated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export const personalRenderReviewSchema = z.object({
  pdfHash: z.string().regex(/^[a-f0-9]{64}$/),
  inspected: z.literal(true),
  notes: z.string().min(1).max(2000),
});
export const personalSettingsSchema = z.object({
  resumeRenderer: z.enum(["cbs-letter-times", "rendercv-classic"]).optional(),
  recruitingAvailability: z
    .object({
      partTimeNow: z.boolean(),
      partTimeMaxHours: z.number().int().min(1).max(40),
      partTimeLocations: z.array(z.string()),
      internshipStartMonth: z
        .string()
        .regex(/^20\d{2}-(0[1-9]|1[0-2])$/)
        .nullable(),
      internshipEndMonth: z
        .string()
        .regex(/^20\d{2}-(0[1-9]|1[0-2])$/)
        .nullable(),
      permanentStartMonth: z
        .string()
        .regex(/^20\d{2}-(0[1-9]|1[0-2])$/)
        .nullable(),
      paidOnly: z.boolean(),
      englishSufficientOnly: z.boolean(),
      employerSupportedInternational: z.boolean(),
      unrestrictedTravelRelocation: z.boolean(),
    })
    .optional(),
  screeningDefaults: z
    .object({
      skillExperience: z
        .array(
          z
            .object({ skill: z.string().trim().min(1).max(100), years: z.number().min(0).max(80) })
            .strict(),
        )
        .max(100)
        .refine(
          (items) => new Set(items.map((item) => item.skill.toLowerCase())).size === items.length,
          "Skill names must be unique",
        ),
      desiredCompensation: z
        .object({
          amount: z.number().nonnegative(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          period: z.enum(["year", "hour"]),
        })
        .strict()
        .nullable(),
      willingToRelocate: z.boolean().nullable(),
      voluntaryDemographics: z.literal("decline").nullable(),
    })
    .strict()
    .optional(),
  mbaEnrolled: z.boolean().nullable().default(null),
  graduationYear: z.number().int().min(2000).max(2100).nullable().default(null),
  availableFrom: z.iso.date().nullable().default(null),
  availableUntil: z.iso.date().nullable().default(null),
  availabilityNotes: z.string().trim().min(1).max(2000).nullable().default(null),
  locations: z.array(z.string()).default([]),
  targetFunctions: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  minimumCompensation: z.number().nonnegative().nullable().default(null),
  compensationCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  compensationPeriod: z.enum(["year", "hour"]).nullable().default(null),
  workAuthorization: z.boolean().nullable().default(null),
  workAuthorizationCountries: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/),
    )
    .default([]),
  requiresSponsorship: z.boolean().nullable().default(null),
  citizenship: z.string().nullable().default(null),
  yearsExperience: z.number().nonnegative().nullable().default(null),
  fitThreshold: z.number().min(0).max(100).default(70),
  dailyCap: z.number().int().nonnegative().default(0),
  maxApplications: z.number().int().nonnegative().default(0),
  timezone: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone")
    .default("America/New_York"),
});
export type PersonalRecordDto = z.infer<typeof personalRecordSchema>;
export type PersonalDashboard = z.infer<typeof personalDashboardSchema>;
export type PersonalSettings = z.infer<typeof personalSettingsSchema>;
