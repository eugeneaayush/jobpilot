import {
  personalApplicationEmailDispatchSchema,
  personalApplicationEmailDraftResponseSchema,
  personalApplicationEmailPrepareSchema,
  personalApplicationEmailResultSchema,
} from "@jobpilot/contracts/personal-application-email-control";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalApplicationEmailService } from "./application-email.service";
import { personalAuthGuard } from "./personal.guard";

const service = container.resolve(PersonalApplicationEmailService);
export const personalApplicationEmailController = new Elysia({
  prefix: "/personal/application-email",
  detail: { tags: ["Personal application email"] },
})
  .use(personalAuthGuard)
  .post(
    "/records/:id/prepare",
    ({ user, params, body }) => service.prepare(user.id, params.id, body),
    {
      params: idParam,
      body: personalApplicationEmailPrepareSchema,
      response: personalApplicationEmailDraftResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Freeze an official application email and reviewed PDFs without sending" },
    },
  )
  .post(
    "/attempts/:id/dispatch",
    ({ user, params, body }) => service.dispatch(user.id, params.id, body),
    {
      params: idParam,
      body: personalApplicationEmailDispatchSchema,
      response: personalApplicationEmailResultSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Dispatch one frozen official application email through a begun attempt" },
    },
  )
  .post(
    "/attempts/:id/reconcile",
    ({ user, params }) => service.reconcileEmail(user.id, params.id),
    {
      params: idParam,
      response: personalApplicationEmailResultSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
      detail: {
        summary: "Verify a Sent receipt without claiming employer acknowledgement or retrying",
      },
    },
  );
