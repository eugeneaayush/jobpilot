import {
  personalDashboardSchema,
  personalDiscoverSchema,
  personalDiscoveryResponseSchema,
  personalIntakeResponseSchema,
  personalQuerySchema,
  personalReassessmentResponseSchema,
  personalRecordSchema,
  personalRenderReviewSchema,
  personalSettingsSchema,
} from "@jobpilot/contracts/personal";
import {
  personalDigestLatestSchema,
  personalDigestTickSchema,
} from "@jobpilot/contracts/personal-digest";
import {
  personalPreparationRequestSchema,
  personalPreparationResponseSchema,
} from "@jobpilot/contracts/personal-preparation";
import {
  personalSearchResponseSchema,
  personalSearchSchema,
} from "@jobpilot/contracts/personal-search";
import {
  personalTailoringResponseSchema,
  personalTailoringReviewSchema,
} from "@jobpilot/contracts/personal-tailoring";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { PersonalDigestService } from "./digest.service";
import { PersonalDiscoveryService } from "./discovery.service";
import { personalAuthGuard } from "./personal.guard";
import { PersonalService } from "./personal.service";
import { PersonalPreparationService } from "./preparation.service";
import { PersonalPreviewService } from "./preview.service";
import { PersonalReassessmentService } from "./reassessment.service";
import { PersonalSearchService } from "./search/search.service";
import { PersonalTailoringService } from "./tailoring.service";

const digest = container.resolve(PersonalDigestService);
const tailoring = container.resolve(PersonalTailoringService);
const search = container.resolve(PersonalSearchService);
const service = container.resolve(PersonalService);
const discovery = container.resolve(PersonalDiscoveryService);
const preview = container.resolve(PersonalPreviewService);
const reassessment = container.resolve(PersonalReassessmentService);
const preparation = container.resolve(PersonalPreparationService);

export const personalController = new Elysia({
  prefix: "/personal",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/", ({ user, query }) => service.dashboard(user.id, query), {
    query: personalQuerySchema,
    response: personalDashboardSchema,
    detail: { summary: "Private recruiting dashboard" },
  })
  .get("/settings", ({ user }) => service.settings(user.id), {
    response: personalSettingsSchema,
    detail: { summary: "Read private recruiting preferences" },
  })
  .put("/settings", ({ user, body }) => service.updateSettings(user.id, body), {
    body: personalSettingsSchema,
    response: personalSettingsSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
    detail: { summary: "Save explicit recruiting preferences" },
  })
  .post("/intake", ({ user }) => service.intake(user.id), {
    response: personalIntakeResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
    detail: { summary: "Import configured private résumé sources" },
  })
  .post("/discover", ({ user, body }) => discovery.discover(user.id, body), {
    body: personalDiscoverSchema,
    response: personalDiscoveryResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
    detail: { summary: "Discover one configured public employer board or import a CBS export" },
  })
  .post("/search", ({ user, body }) => search.search(user.id, body), {
    body: personalSearchSchema,
    response: personalSearchResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Discover career URL candidates with a reserved search budget" },
  })
  .post("/reassess", ({ user }) => reassessment.reassess(user.id), {
    response: personalReassessmentResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Reassess saved postings against current facts without employer requests" },
  })
  .get("/digest/latest", async ({ user }) => ({ digest: await digest.latest(user.id) }), {
    response: personalDigestLatestSchema,
    detail: { summary: "Read the latest private local digest" },
  })
  .post("/digest/tick", ({ user }) => digest.tick(user.id), {
    response: personalDigestTickSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    detail: { summary: "Create the daily local digest when its scheduled time is due" },
  })
  .get("/:id", ({ user, params }) => service.record(user.id, params.id), {
    params: idParam,
    response: personalRecordSchema,
    detail: { summary: "Inspect an owned personal record" },
  })
  .get("/:id/tailoring", ({ user, params }) => tailoring.get(user.id, params.id), {
    params: idParam,
    response: personalTailoringResponseSchema,
  })
  .post(
    "/:id/preparation",
    ({ user, params, body, request }) =>
      preparation.advance(user.id, params.id, body.campaignId, request.signal),
    {
      params: idParam,
      body: personalPreparationRequestSchema,
      response: personalPreparationResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
      detail: {
        summary: "Advance one bounded private preparation phase for an authorized campaign",
      },
    },
  )
  .post(
    "/:id/tailoring",
    ({ user, params, request }) => tailoring.propose(user.id, params.id, request.signal),
    {
      params: idParam,
      response: personalTailoringResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    },
  )
  .post(
    "/:id/tailoring/review",
    ({ user, params, body }) => tailoring.review(user.id, params.id, body),
    {
      params: idParam,
      body: personalTailoringReviewSchema,
      response: personalTailoringResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotMutation),
    },
  )
  .post("/:id/preview", ({ user, params }) => preview.preview(user.id, params.id), {
    params: idParam,
    response: personalRecordSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
    detail: { summary: "Prepare an offline preview without employer requests" },
  })
  .get("/:id/form-preview", ({ user, params }) => preview.form(user.id, params.id), {
    params: idParam,
    detail: { summary: "Read a synthetic offline form; no employer transmission" },
  })
  .post(
    "/:id/render-review",
    ({ user, params, body }) => preview.review(user.id, params.id, body),
    {
      params: idParam,
      body: personalRenderReviewSchema,
      response: personalRecordSchema,
      beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
      detail: { summary: "Record inspection of an exact PDF; unresolved conflicts remain draft" },
    },
  )
  .get("/:id/pdf", ({ user, params }) => service.pdf(user.id, params.id), {
    params: idParam,
    beforeHandle: rateLimit(RATE_LIMITS.pilotClaim),
    detail: { summary: "Read the owned immutable preview PDF" },
  });
