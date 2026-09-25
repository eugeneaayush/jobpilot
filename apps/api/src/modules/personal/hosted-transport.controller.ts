import {
  personalHostedTransportFreezeSchema,
  personalHostedTransportResponseSchema,
} from "@jobpilot/contracts/personal-hosted-transport";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { unauthorized } from "@/common/errors";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { ApiTokenService } from "@/modules/auth/api-token.service";
import { PersonalHostedTransportService } from "./hosted-transport.service";
import { personalAuthGuard } from "./personal.guard";

const svc = container.resolve(PersonalHostedTransportService);
const tokens = container.resolve(ApiTokenService);
const limit = rateLimit(RATE_LIMITS.pilotClaim);
export const personalHostedTransportController = new Elysia({
  name: "personal-hosted-transport",
  prefix: "/personal/attempts",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .post(
    "/:id/hosted-transport/freeze",
    async ({ user, params, body }) => svc.freeze(user.id, params.id, body),
    {
      params: idParam,
      body: personalHostedTransportFreezeSchema,
      response: personalHostedTransportResponseSchema,
      beforeHandle: [
        async ({
          headers,
          user,
        }: {
          headers: Record<string, string | undefined>;
          user: { id: string };
        }) => {
          const authorization = headers.authorization;
          const raw = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
          const principal = raw ? await tokens.verify(raw) : null;
          if (!principal || principal.id !== user.id)
            throw unauthorized("Hosted transport freeze requires the owned broker API token.");
        },
        limit,
      ],
      detail: { summary: "Freeze exact Lever hosted application request hashes before forwarding" },
    },
  );
