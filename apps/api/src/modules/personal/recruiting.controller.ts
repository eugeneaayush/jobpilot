import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalAuthGuard } from "./personal.guard";
import { personalRecruitingResponseSchema } from "./recruiting.schema";
import { PersonalRecruitingService } from "./recruiting.service";

const service = container.resolve(PersonalRecruitingService);

export const personalRecruitingController = new Elysia({
  prefix: "/personal/recruiting",
  detail: { tags: ["Personal"] },
})
  .use(personalAuthGuard)
  .get("/", ({ user }) => service.dashboard(user.id), {
    response: personalRecruitingResponseSchema,
    beforeHandle: rateLimit(RATE_LIMITS.pilotAgenda),
    detail: { summary: "Read the private MBB recruiting snapshot" },
  });
