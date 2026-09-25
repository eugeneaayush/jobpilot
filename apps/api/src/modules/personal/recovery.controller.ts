import {
  personalEligibilityAdjudicationSchema,
  personalRecordRecoverySchema,
  personalRecoveryQuerySchema,
  personalRecoveryResponseSchema,
} from "@jobpilot/contracts/personal-recovery";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "./personal.guard";
import { PersonalRecoveryService } from "./recovery.service";

const service = container.resolve(PersonalRecoveryService);
export const personalRecoveryController = new Elysia({
  prefix: "/personal/recovery",
  detail: { tags: ["Personal recovery"] },
})
  .use(personalAuthGuard)
  .get(
    "/records/:id",
    ({ user, params, query }) => service.get(user.id, params.id, query.targetCampaignId),
    {
      params: idParam,
      query: personalRecoveryQuerySchema,
      response: personalRecoveryResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
      detail: { summary: "Inspect source-bound eligibility decisions and recovery holds" },
    },
  )
  .post(
    "/records/:id/eligibility",
    ({ user, params, body }) => service.adjudicate(user.id, params.id, body),
    {
      params: idParam,
      body: personalEligibilityAdjudicationSchema,
      response: personalRecoveryResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Record exact sourced decisions for individual eligibility requirements" },
    },
  )
  .post(
    "/records/:id/recover",
    ({ user, params, body }) => service.recover(user.id, params.id, body),
    {
      params: idParam,
      body: personalRecordRecoverySchema,
      response: personalRecoveryResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: {
        summary: "Requeue resolved pre-submission blocks under existing campaign authority",
      },
    },
  );
