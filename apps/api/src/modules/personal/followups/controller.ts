import {
  personalFollowupDraftInputSchema,
  personalFollowupObservationSchema,
  personalFollowupResponseSchema,
} from "@jobpilot/contracts/personal-followups";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "../personal.guard";
import { PersonalFollowupService } from "./service";

const service = container.resolve(PersonalFollowupService);
export const personalFollowupController = new Elysia({
  name: "personal-followups",
  prefix: "/personal/followups",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/records/:id", ({ user, params }) => service.get(user.id, params.id), {
    params: idParam,
    response: personalFollowupResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Read submitted-material follow-up drafts and observed delivery evidence" },
  })
  .post(
    "/records/:id",
    ({ user, params, body }) => service.draft(user.id, params.id, body.recordVersion),
    {
      params: idParam,
      body: personalFollowupDraftInputSchema,
      response: personalFollowupResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Prepare a follow-up draft after ten quiet days without sending" },
    },
  )
  .post(
    "/records/:id/observations",
    ({ user, params, body }) => service.observe(user.id, params.id, body),
    {
      params: idParam,
      body: personalFollowupObservationSchema,
      response: personalFollowupResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: {
        summary:
          "Record existing provider receipts or correlated employer replies for an exact draft",
      },
    },
  );
