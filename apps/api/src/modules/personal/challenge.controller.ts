import {
  personalChallengeConsumeSchema,
  personalChallengeContinueSchema,
  personalChallengeEvidenceSchema,
  personalChallengeFenceSchema,
  personalChallengeFreezeSchema,
  personalChallengeLeaseSchema,
  personalChallengeResponseSchema,
} from "@jobpilot/contracts/personal-challenge";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalChallengeService } from "./challenge.service";
import { personalAuthGuard } from "./personal.guard";

const svc = container.resolve(PersonalChallengeService);
const limit = rateLimit(RATE_LIMITS.pilotClaim);
export const personalChallengeController = new Elysia({
  name: "personal-challenges",
  prefix: "/personal/attempts",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/:id/challenge", async ({ user, params }) => svc.get(user.id, params.id), {
    params: idParam,
    response: personalChallengeResponseSchema,
    beforeHandle: limit,
    detail: { summary: "Inspect an owned post-submit challenge without applicant data" },
  })
  .post(
    "/:id/challenge/freeze",
    async ({ user, params, body }) => svc.freeze(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeFreezeSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: { summary: "Freeze the original Greenhouse request before forwarding" },
    },
  )
  .post(
    "/:id/challenge",
    async ({ user, params, body }) => svc.register(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeEvidenceSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: {
        summary: "Record a recognized post-submit challenge without releasing the submission",
      },
    },
  )
  .post(
    "/:id/challenge/lease",
    async ({ user, params, body }) => svc.lease(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeLeaseSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: { summary: "Lease a challenge for explicit user handling" },
    },
  )
  .post(
    "/:id/challenge/checkpoint",
    async ({ user, params, body }) => svc.checkpoint(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeFenceSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: { summary: "Renew a user challenge lease" },
    },
  )
  .post(
    "/:id/challenge/continue",
    async ({ user, params, body }) => svc.continue(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeContinueSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: { summary: "Authorize one unchanged application continuation" },
    },
  )
  .post(
    "/:id/challenge/consume",
    async ({ user, params, body }) => svc.consume(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeConsumeSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: { summary: "Consume a continuation permit exactly once before forwarding" },
    },
  )
  .post(
    "/:id/challenge/cancel",
    async ({ user, params, body }) => svc.cancel(user.id, params.id, body),
    {
      params: idParam,
      body: personalChallengeFenceSchema,
      response: personalChallengeResponseSchema,
      beforeHandle: limit,
      detail: { summary: "Cancel user handling while retaining the submission hold" },
    },
  );
