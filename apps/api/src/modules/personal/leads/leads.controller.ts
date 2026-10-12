import {
  personalLeadBatchResponseSchema,
  personalLeadDiscoverSchema,
  personalLeadFeedImportSchema,
  personalLeadImportSchema,
  personalLeadQuerySchema,
  personalLeadResolveSchema,
  personalLeadSchema,
  personalLeadsResponseSchema,
} from "@jobpilot/contracts/personal-leads";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "../personal.guard";
import { PersonalLeadsService } from "./leads.service";

const service = container.resolve(PersonalLeadsService);
export const personalLeadsController = new Elysia({
  prefix: "/personal/leads",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/", ({ user, query }) => service.list(user.id, query), {
    query: personalLeadQuerySchema,
    response: personalLeadsResponseSchema,
    detail: { summary: "List unverified discovery leads" },
  })
  .post("/import", ({ user, body }) => service.import(user.id, body), {
    body: personalLeadImportSchema,
    response: personalLeadBatchResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Import lead candidates without application authority" },
  })
  .post("/discover", ({ user, body }) => service.discover(user.id, body), {
    body: personalLeadDiscoverSchema,
    response: personalLeadBatchResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Run an explicitly enabled board lead query" },
  })
  .post("/feeds/import", ({ user, body }) => service.importFeed(user.id, body), {
    body: personalLeadFeedImportSchema,
    response: personalLeadBatchResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Parse an explicitly enabled recruiting feed snapshot" },
  })
  .post("/:id/resolve", ({ user, params, body }) => service.resolve(user.id, params.id, body), {
    params: idParam,
    body: personalLeadResolveSchema,
    response: personalLeadSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Resolve a lead through registered campaign-authorized official discovery" },
  });
