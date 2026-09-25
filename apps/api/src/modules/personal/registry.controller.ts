import { paginationQuerySchema } from "@jobpilot/contracts/pagination";
import {
  personalEmployerAliasUpsertSchema,
  personalRegistryAliasesSchema,
  personalRegistryAliasSchema,
  personalRegistryResponseSchema,
  personalRegistrySourceSchema,
  personalSourceUpsertSchema,
  personalUserPolicySchema,
  personalUserPolicyUpdateSchema,
} from "@jobpilot/contracts/personal-registry";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "./personal.guard";
import { PersonalSourceRegistryService } from "./source-registry.service";

const service = container.resolve(PersonalSourceRegistryService);
export const personalRegistryController = new Elysia({
  prefix: "/personal",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/registry", ({ user, query }) => service.list(user.id, query), {
    query: paginationQuerySchema,
    response: personalRegistryResponseSchema,
  })
  .put("/registry", ({ user, body }) => service.upsert(user.id, body), {
    body: personalSourceUpsertSchema,
    response: personalRegistrySourceSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
  })
  .get("/aliases", ({ user, query }) => service.listAliases(user.id, query), {
    query: paginationQuerySchema,
    response: personalRegistryAliasesSchema,
  })
  .put("/aliases", ({ user, body }) => service.registerAlias(user.id, body), {
    body: personalEmployerAliasUpsertSchema,
    response: personalRegistryAliasSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
  })
  .get("/policy", ({ user }) => service.policy(user.id), { response: personalUserPolicySchema })
  .put("/policy", ({ user, body }) => service.configurePolicy(user.id, body), {
    body: personalUserPolicyUpdateSchema,
    response: personalUserPolicySchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
  });
