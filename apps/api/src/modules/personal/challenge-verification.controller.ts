import { Elysia } from "elysia";
import { z } from "zod";
import { forbidden } from "@/common/errors";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { env } from "@/env";
import { continueGreenhouseVerification } from "../../../../../plugin/scripts/personal-browser/greenhouse-continuation";
import { personalAuthGuard } from "./personal.guard";
import { personalRoot } from "./runtime";

// Verification credentials travel only between the user's private UI and local transport.
export const personalChallengeVerificationController = new Elysia({
  name: "personal-challenge-verification",
  prefix: "/personal/attempts",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .post(
    "/:id/challenge/verify",
    async ({ params, body, headers }) => {
      if (!env.PERSONAL_MODE || !headers.authorization?.startsWith("Bearer "))
        throw forbidden("Private bearer-authenticated verification is required");
      return continueGreenhouseVerification(
        {
          api: `http://127.0.0.1:${env.PORT}`,
          token: headers.authorization.slice(7),
          root: personalRoot(),
        },
        { attemptId: params.id, challengeId: body.challengeId, code: body.code },
      );
    },
    {
      params: z.object({ id: z.uuid() }),
      body: z
        .object({ challengeId: z.uuid(), code: z.string().regex(/^[a-zA-Z0-9]{8}$/) })
        .strict(),
      response: z.object({
        status: z.enum(["submitted", "submission_uncertain"]),
        receiptHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        needsUser: z.string().optional(),
      }),
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
    },
  );
