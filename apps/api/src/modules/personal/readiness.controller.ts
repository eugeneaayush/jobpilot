import {
  personalReadinessSchema,
  personalScreeningAnswersInputSchema,
  personalScreeningAnswersResponseSchema,
} from "@jobpilot/contracts/personal-readiness";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "./personal.guard";
import { PersonalReadinessService } from "./readiness.service";

const service = container.resolve(PersonalReadinessService);
export const personalReadinessController = new Elysia({
  prefix: "/personal/readiness",
  detail: { tags: ["Personal readiness"] },
})
  .use(personalAuthGuard)
  .get("/", ({ user, headers }) => service.get(user.id, headers.authorization), {
    response: personalReadinessSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
    detail: { summary: "Inspect verified setup and per-job readiness requirements" },
  })
  .get("/records/:id/answers", ({ user, params }) => service.answers(user.id, params.id), {
    params: idParam,
    response: personalScreeningAnswersResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
    detail: { summary: "Read the current immutable screening-answer snapshot" },
  })
  .post(
    "/records/:id/answers",
    ({ user, params, body }) => service.saveAnswers(user.id, params.id, body),
    {
      params: idParam,
      body: personalScreeningAnswersInputSchema,
      response: personalScreeningAnswersResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Save exact sourced or explicitly confirmed screening answers" },
    },
  );
