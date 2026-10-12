import {
  personalYamlExportSchema,
  personalYamlImportResponseSchema,
  personalYamlImportSchema,
} from "@jobpilot/contracts/personal-yaml";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "./personal.guard";
import { PersonalYamlService } from "./yaml.service";

const service = container.resolve(PersonalYamlService);

export const personalYamlController = new Elysia({
  name: "personal-resume-yaml",
  prefix: "/personal",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get(
    "/:id/resume-yaml",
    ({ user, params, request }) => service.export(user.id, params.id, request.signal),
    {
      params: idParam,
      response: personalYamlExportSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Export a source-bound private RenderCV YAML bundle" },
    },
  )
  .post(
    "/:id/resume-yaml",
    ({ user, params, body, request }) => service.import(user.id, params.id, body, request.signal),
    {
      params: idParam,
      body: personalYamlImportSchema,
      response: personalYamlImportResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: { summary: "Propose YAML cuts, ordering and bullet rewrites for independent review" },
    },
  );
