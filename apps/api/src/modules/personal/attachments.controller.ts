import {
  personalAttachmentReviewInputSchema,
  personalAttachmentsResponseSchema,
  personalCoverLetterInputSchema,
} from "@jobpilot/contracts/personal-attachments";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { z } from "zod/v4";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalAttachmentsService } from "./attachments.service";
import { personalAuthGuard } from "./personal.guard";

const service = container.resolve(PersonalAttachmentsService);
export const personalAttachmentsController = new Elysia({
  prefix: "/personal/attachments",
  detail: { tags: ["Personal attachments"] },
})
  .use(personalAuthGuard)
  .get("/:id", ({ user, params }) => service.get(user.id, params.id), {
    params: idParam,
    response: personalAttachmentsResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
    detail: { summary: "Read sourced employer file requirements and document reviews" },
  })
  .post("/:id/requirements/refresh", ({ user, params }) => service.refresh(user.id, params.id), {
    params: idParam,
    response: personalAttachmentsResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Read public Greenhouse file questions without applicant transmission" },
  })
  .post(
    "/:id/cover-letter",
    ({ user, params, body }) => service.coverLetter(user.id, params.id, body),
    {
      params: idParam,
      body: personalCoverLetterInputSchema,
      response: personalAttachmentsResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Generate a sourced cover-letter draft for an observed file field" },
    },
  )
  .post("/:id/review", ({ user, params, body }) => service.review(user.id, params.id, body), {
    params: idParam,
    body: personalAttachmentReviewInputSchema,
    response: personalAttachmentsResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Record explicit inspection of an exact attachment PDF hash" },
  })
  .get("/:id/:hash/pdf", ({ user, params }) => service.pdf(user.id, params.id, params.hash), {
    params: idParam.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
    detail: { summary: "Read an immutable owned attachment PDF version" },
  });
