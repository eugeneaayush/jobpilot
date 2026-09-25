import {
  personalCampaignCreateSchema,
  personalCampaignLaunchSchema,
  personalCampaignListSchema,
  personalCampaignNextResponseSchema,
  personalCampaignNextSchema,
  personalCampaignQuerySchema,
  personalCampaignSchema,
  personalCampaignStopSchema,
} from "@jobpilot/contracts/personal-campaign";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalCampaignService } from "./campaign.service";
import { personalAuthGuard } from "./personal.guard";

const service = container.resolve(PersonalCampaignService);
export const personalCampaignController = new Elysia({
  prefix: "/personal/campaigns",
  detail: { tags: ["Personal campaigns"] },
})
  .use(personalAuthGuard)
  .post("/", ({ user, body }) => service.create(user.id, body), {
    body: personalCampaignCreateSchema,
    response: personalCampaignSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Configure a stopped personal campaign" },
  })
  .get("/", ({ user, query }) => service.list(user.id, query), {
    query: personalCampaignQuerySchema,
    response: personalCampaignListSchema,
    beforeHandle: rateLimit(RATE_LIMITS.personalCampaignRead),
    detail: { summary: "List owned personal campaigns" },
  })
  .post(
    "/:id/launch",
    ({ user, params, body }) => service.launch(user.id, params.id, body.confirm),
    {
      params: idParam,
      body: personalCampaignLaunchSchema,
      response: personalCampaignSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalCampaignSchedule),
      detail: { summary: "Explicitly authorize and launch a personal campaign" },
    },
  )
  .post("/:id/stop", ({ user, params, body }) => service.stop(user.id, params.id, body.reason), {
    params: idParam,
    body: personalCampaignStopSchema,
    response: personalCampaignSchema,
    beforeHandle: rateLimit(RATE_LIMITS.personalCampaignStop),
    detail: { summary: "Stop scheduling and revoke pre-submit leases" },
  })
  .post(
    "/:id/next",
    ({ user, params, body }) => service.next(user.id, params.id, body.leaseOwner),
    {
      params: idParam,
      body: personalCampaignNextSchema,
      response: personalCampaignNextResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalCampaignSchedule),
      detail: { summary: "Lease one prepared record under the authorized campaign policy" },
    },
  );
