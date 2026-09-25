import {
  personalAttemptFinishPreviewSchema,
  personalAttemptLeaseSchema,
  personalAttemptParkSchema,
  personalAttemptReceiptSchema,
  personalAttemptReconcileSchema,
  personalAttemptResponseSchema,
  personalAttemptStartSchema,
} from "@jobpilot/contracts/personal-attempt";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalAttemptService } from "./attempt.service";
import { personalAuthGuard } from "./personal.guard";

const svc = container.resolve(PersonalAttemptService);

export const personalAttemptController = new Elysia({
  name: "personal-attempts",
  prefix: "/personal/attempts",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get(
    "/:id",
    async ({ user, params }) =>
      personalAttemptResponseSchema.parse(await svc.get(user.id, params.id)),
    {
      params: idParam,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalAttemptControl),
      detail: {
        summary: "Inspect an owned attempt and resolve expired submission leases to uncertain",
      },
    },
  )
  .post(
    "/",
    async ({ user, body }) => personalAttemptResponseSchema.parse(await svc.start(user.id, body)),
    {
      body: personalAttemptStartSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Reserve a personal attempt under an explicit campaign policy" },
    },
  )
  .post(
    "/:id/checkpoint",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(await svc.checkpoint(user.id, params.id, body)),
    {
      params: idParam,
      body: personalAttemptLeaseSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalAttemptControl),
      detail: { summary: "Renew a preparation lease" },
    },
  )
  .post(
    "/:id/prepare",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(await svc.prepare(user.id, params.id, body)),
    {
      params: idParam,
      body: personalAttemptLeaseSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Complete attempt preparation" },
    },
  )
  .post(
    "/:id/begin-submit",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(await svc.beginSubmit(user.id, params.id, body)),
    {
      params: idParam,
      body: personalAttemptLeaseSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Cross the one-time submission boundary" },
    },
  )
  .post(
    "/:id/receipt",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(
        await svc.receipt(user.id, params.id, body, body.evidence),
      ),
    {
      params: idParam,
      body: personalAttemptReceiptSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Attach a hashed submission confirmation artifact" },
    },
  )
  .post(
    "/:id/reconcile",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(await svc.reconcile(user.id, params.id, body.evidence)),
    {
      params: idParam,
      body: personalAttemptReconcileSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Resolve an uncertain submission using evidence" },
    },
  )
  .post(
    "/:id/cancel",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(await svc.cancel(user.id, params.id, body)),
    {
      params: idParam,
      body: personalAttemptLeaseSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Cancel preparation before submission begins" },
    },
  )
  .post(
    "/:id/finish-preview",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(
        await svc.finishPreview(user.id, params.id, body, body.manifestHash),
      ),
    {
      params: idParam,
      body: personalAttemptFinishPreviewSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Finish an offline preview with a durable quota debit" },
    },
  )
  .post(
    "/:id/park",
    async ({ user, params, body }) =>
      personalAttemptResponseSchema.parse(
        await svc.park(user.id, params.id, body, body.kind, body.reason),
      ),
    {
      params: idParam,
      body: personalAttemptParkSchema,
      response: personalAttemptResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Park an affected attempt while preserving any submission uncertainty" },
    },
  );
