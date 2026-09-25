import "@/common/di/container";
import { Elysia } from "elysia";
import { db } from "@/common/database/prisma.client";
import { logger } from "@/common/logger";
import { errorMiddleware } from "@/common/middleware";
import { corsPlugin } from "@/common/plugins/cors.plugin";
import { swaggerPlugin } from "@/common/plugins/swagger.plugin";
import { env } from "@/env";
import { adminController } from "@/modules/admin/admin.controller";
import { analyticsController } from "@/modules/analytics/analytics.controller";
import { applicationController } from "@/modules/application/application.controller";
import { authController } from "@/modules/auth/auth.controller";
import { authProvidersController } from "@/modules/auth/providers.controller";
import { securityController } from "@/modules/auth/security.controller";
import { campaignController } from "@/modules/campaign/campaign.controller";
import { campaignJobController } from "@/modules/campaign/jobs/job.controller";
import { networkingMessageController } from "@/modules/campaign/networking/message.controller";
import { campaignNetworkingController } from "@/modules/campaign/networking/networking.controller";
import { captchaController } from "@/modules/captcha/captcha.controller";
import { contactController } from "@/modules/contact";
import { coverLetterController } from "@/modules/cover-letter/cover-letter.controller";
import { credentialController } from "@/modules/credential/credential.controller";
import { emailAccountController } from "@/modules/email/account/account.controller";
import { emailMessagesController } from "@/modules/email/messages.controller";
import { emailOAuthController } from "@/modules/email/oauth.controller";
import { healthController } from "@/modules/health/health.controller";
import { adminBoardController } from "@/modules/job-board/admin-board.controller";
import { jobBoardController } from "@/modules/job-board/job-board.controller";
import { adminJobListingController, publicJobListingController } from "@/modules/job-listing";
import { cleanupJob } from "@/modules/maintenance/cleanup.job";
import { personalApplicationEmailController } from "@/modules/personal/application-email.controller";
import { personalAttachmentsController } from "@/modules/personal/attachments.controller";
import { personalAttemptController } from "@/modules/personal/attempt.controller";
import { personalCampaignController } from "@/modules/personal/campaign.controller";
import { personalChallengeController } from "@/modules/personal/challenge.controller";
import { personalChallengeVerificationController } from "@/modules/personal/challenge-verification.controller";
import { personalHandoffController } from "@/modules/personal/handoff.controller";
import { personalHostedTransportController } from "@/modules/personal/hosted-transport.controller";
import { personalController } from "@/modules/personal/personal.controller";
import { isPrivateOnlyRoute } from "@/modules/personal/privacy";
import { personalReadinessController } from "@/modules/personal/readiness.controller";
import { personalRecoveryController } from "@/modules/personal/recovery.controller";
import { personalRecruitingController } from "@/modules/personal/recruiting.controller";
import { personalRegistryController } from "@/modules/personal/registry.controller";
import { pilotController } from "@/modules/pilot/pilot.controller";
import { pilotAgendaController } from "@/modules/pilot/pilot-agenda.controller";
import { pilotClaimsController } from "@/modules/pilot/pilot-claims.controller";
import { pilotJournalController } from "@/modules/pilot/pilot-journal.controller";
import { pilotQuestionsController } from "@/modules/pilot/pilot-questions.controller";
import { pilotSearchController } from "@/modules/pilot/pilot-search.controller";
import { promotionController } from "@/modules/pilot/promotion.controller";
import { publicPortfolioController } from "@/modules/portfolio/portfolio.controller";
import { pushController } from "@/modules/push/push.controller";
import { resumeFileController } from "@/modules/resume/files/file.controller";
import { publicResumeController } from "@/modules/resume/files/public.controller";
import { resumeController } from "@/modules/resume/resume.controller";
import { resumeJob } from "@/modules/resume/resume.job";
import { resumeVariantController } from "@/modules/resume/variants/variant.controller";
import { scoringController } from "@/modules/scoring/scoring.controller";
import { upworkController } from "@/modules/upwork/upwork.controller";
import { userController } from "@/modules/user/user.controller";
import { workspaceController } from "@/modules/workspace/workspace.controller";
import { httpErrorResponses } from "@/types/response";

const app = new Elysia()
  .onRequest(({ request }) => {
    if (env.PERSONAL_MODE && isPrivateOnlyRoute(new URL(request.url).pathname)) {
      return new Response("Not found", { status: 404 });
    }
  })
  .use(errorMiddleware)
  .use(corsPlugin)
  .use(swaggerPlugin)
  .use(resumeJob)
  .use(cleanupJob)
  .onStop(async () => {
    await db.$disconnect();
  })
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  .guard({ as: "scoped", response: httpErrorResponses })
  .group("/api", (api) =>
    api
      .use(authController)
      .use(securityController)
      .use(authProvidersController)
      .use(healthController)
      .use(personalRegistryController)
      .use(personalApplicationEmailController)
      .use(personalHostedTransportController)
      .use(personalController)
      .use(personalRecruitingController)
      .use(personalAttemptController)
      .use(personalAttachmentsController)
      .use(personalCampaignController)
      .use(personalChallengeController)
      .use(personalChallengeVerificationController)
      .use(personalHandoffController)
      .use(personalReadinessController)
      .use(personalRecoveryController)
      .use(jobBoardController)
      .use(credentialController)
      .use(contactController)
      .use(networkingMessageController)
      .use(analyticsController)
      .use(captchaController)
      .use(userController)
      .use(resumeController)
      .use(resumeFileController)
      .use(resumeVariantController)
      .use(publicResumeController)
      .use(publicJobListingController)
      .use(publicPortfolioController)
      .use(coverLetterController)
      .use(applicationController)
      .use(scoringController)
      .use(upworkController)
      .use(campaignController)
      .use(campaignJobController)
      .use(campaignNetworkingController)
      .use(pilotController)
      .use(pilotSearchController)
      .use(pilotAgendaController)
      .use(pilotClaimsController)
      .use(pilotJournalController)
      .use(pilotQuestionsController)
      .use(promotionController)
      .use(pushController)
      .use(workspaceController)
      .use(emailAccountController)
      .use(emailMessagesController)
      .use(emailOAuthController)
      // Mounted one by one: an array widens them to AnyElysia and collapses the `App` type Eden reads.
      .use(adminController)
      .use(adminBoardController)
      .use(adminJobListingController),
  )
  .listen({ port: env.PORT, hostname: env.HOST });

logger.info(`JobPilot API running at http://localhost:${app.server?.port}`);
if (env.NODE_ENV === "development") {
  logger.info(`Swagger docs at http://localhost:${app.server?.port}/swagger`);
}

// Eden Treaty contract for the frontend.
export type App = typeof app;
