import { personalAttemptLeaseSchema } from "@jobpilot/contracts/personal-attempt";
import {
  PERSONAL_HANDOFF_REASONS,
  personalHandoffLeaseSchema,
  personalHandoffResponseSchema,
} from "@jobpilot/contracts/personal-handoff";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalHandoffService } from "./handoff.service";
import { personalAuthGuard } from "./personal.guard";

const svc = container.resolve(PersonalHandoffService);
const limit = rateLimit(RATE_LIMITS.pilotClaim);
export const personalHandoffController = new Elysia({
  name: "personal-handoff",
  prefix: "/personal/attempts",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/:id/handoff", ({ user, params }) => svc.get(user.id, params.id), {
    params: idParam,
    response: personalHandoffResponseSchema,
    beforeHandle: limit,
  })
  .post("/:id/handoff/request", ({ user, params, body }) => svc.request(user.id, params.id, body), {
    params: idParam,
    body: personalAttemptLeaseSchema.extend({ reason: z.enum(PERSONAL_HANDOFF_REASONS) }),
    response: personalHandoffResponseSchema,
    beforeHandle: limit,
  })
  .post(
    "/:id/handoff/:action",
    ({ user, params, body }) => svc.transition(user.id, params.id, params.action, body),
    {
      params: idParam.extend({ action: z.enum(["open", "heartbeat", "resume", "cancel"]) }),
      body: personalHandoffLeaseSchema,
      response: personalHandoffResponseSchema,
      beforeHandle: limit,
    },
  );
