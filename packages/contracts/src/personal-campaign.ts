import { z } from "zod/v4";
import { paginatedSchema, paginationQuerySchema } from "./pagination";
import { PERSONAL_TRACKS } from "./personal-attempt";

const personalCampaignRoleScopeSchema = z.object({
  internshipOnly: z.boolean(),
  categories: z
    .array(z.enum(["tech_product_management", "mbb_consulting", "buy_side_investing"]))
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length, "Categories must be unique"),
});

const settings = {
  name: z.string().trim().min(1).max(200),
  mode: z.enum(["offline", "submit"]),
  sources: z
    .object({
      boardTokens: z
        .array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/))
        .min(0)
        .max(50),
      instances: z
        .array(
          z.object({
            source: z.enum(["greenhouse", "lever", "ashby", "cbs"]),
            boardToken: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            region: z.enum(["global", "eu"]).optional(),
          }),
        )
        .max(500)
        .optional(),
    })
    .refine(
      (s) => s.boardTokens.length > 0 || (s.instances?.length ?? 0) > 0,
      "At least one source is required",
    ),
  tracks: z.array(z.enum(PERSONAL_TRACKS)).min(1).max(3),
  roleScope: personalCampaignRoleScopeSchema.optional(),
  fitThreshold: z.number().min(0).max(100),
  dailyCap: z.number().int().positive().max(1000),
  maxApplications: z.number().int().positive().max(10000),
  timezone: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
};
export const personalCampaignCreateSchema = z.object(settings);
export const personalCampaignLaunchSchema = z.object({ confirm: z.literal(true) });
export const personalCampaignStopSchema = z.object({ reason: z.string().max(1000).optional() });
export const personalCampaignNextSchema = z.object({ leaseOwner: z.string().min(1).max(200) });
export const personalCampaignQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "stopped"]).optional(),
});
export const personalCampaignSchema = z.object({
  ...settings,
  id: z.uuid(),
  status: z.enum(["active", "stopped"]),
  policyVersion: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  authorization: z
    .object({
      runId: z.uuid(),
      authorizedAt: z.string(),
      settingsHash: z.string(),
      resumeEvidenceId: z.uuid(),
      sourceHash: z.string(),
      snapshotHash: z.string(),
    })
    .nullable(),
});
export const personalCampaignListSchema = paginatedSchema(personalCampaignSchema);
export const personalCampaignNextResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("idle"),
    campaignId: z.uuid(),
    reasons: z.array(z.string()),
    parked: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("task"),
    campaignId: z.uuid(),
    mode: z.enum(["offline", "submit"]),
    attempt: z.object({
      id: z.uuid(),
      leaseOwner: z.string(),
      leaseGeneration: z.number().int(),
      manifestHash: z.string(),
      state: z.literal("prepared"),
    }),
    record: z.object({
      id: z.uuid(),
      identity: z.string(),
      title: z.string(),
      company: z.string(),
      url: z.string(),
      track: z.enum(PERSONAL_TRACKS),
    }),
    task: z.object({
      kind: z.enum(["offline_preview", "apply"]),
      applicationMethod: z.enum(["browser", "official_email"]).optional(),
      attemptId: z.uuid(),
      brokerPath: z.string(),
    }),
  }),
]);
export type PersonalCampaignCreateInput = z.infer<typeof personalCampaignCreateSchema>;
export type PersonalCampaign = z.infer<typeof personalCampaignSchema>;
export type PersonalCampaignNextResponse = z.infer<typeof personalCampaignNextResponseSchema>;
export type PersonalCampaignQuery = z.infer<typeof personalCampaignQuerySchema>;
