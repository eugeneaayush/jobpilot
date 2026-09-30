import {
  personalBatchAdvanceSchema,
  personalBatchCreateSchema,
  personalBatchListSchema,
  personalBatchQuerySchema,
  personalBatchSchema,
  personalBatchSuggestionsSchema,
  personalBatchSuggestSchema,
} from "@jobpilot/contracts/personal-batch";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "../personal.guard";
import { PersonalBatchesService } from "./batches.service";

const service = container.resolve(PersonalBatchesService);
export const personalBatchesController = new Elysia({
  prefix: "/personal/batches",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/", ({ user, query }) => service.list(user.id, query), {
    query: personalBatchQuerySchema,
    response: personalBatchListSchema,
    detail: { summary: "List shared tailoring analyses and independent member progress" },
  })
  .post("/suggest", ({ user, body }) => service.suggest(user.id, body), {
    body: personalBatchSuggestSchema,
    response: personalBatchSuggestionsSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Suggest 3–5 related records without changing them" },
  })
  .post("/", ({ user, body }) => service.create(user.id, body), {
    body: personalBatchCreateSchema,
    response: personalBatchSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Freeze a shared gap analysis and one source-evidence interview" },
  })
  .get("/:id", ({ user, params }) => service.get(user.id, params.id), {
    params: idParam,
    response: personalBatchSchema,
    detail: { summary: "Read batch evidence, source question and individual document progress" },
  })
  .post(
    "/:id/advance",
    ({ user, params, body, request }) => service.advance(user.id, params.id, body, request.signal),
    {
      params: idParam,
      body: personalBatchAdvanceSchema,
      response: personalBatchSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: {
        summary: "Advance one independent preparation phase, preserving completed members",
      },
    },
  );
