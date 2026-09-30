import {
  personalApprovalInputSchema,
  personalApprovalResponseSchema,
  personalApprovalWithdrawSchema,
} from "@jobpilot/contracts/personal-approval";
import { idParam } from "@jobpilot/contracts/shared";
import { Elysia } from "elysia";
import { container } from "@/common/di/container";
import { RATE_LIMITS, rateLimit } from "@/common/rate-limit";
import { personalApprovalGuard } from "./approval.guard";
import { PersonalApprovalService } from "./approval.service";

const service = container.resolve(PersonalApprovalService);
export const personalApprovalController = new Elysia({
  name: "personal-approvals",
  prefix: "/personal/approvals",
  detail: { tags: ["Personal"] },
})
  .use(personalApprovalGuard)
  .get(
    "/records/:id",
    ({ user, params, approvalSession }) => service.get(user.id, params.id, approvalSession),
    {
      params: idParam,
      response: personalApprovalResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalAttemptControl),
      detail: { summary: "Review exact application packet in the dashboard" },
    },
  )
  .post(
    "/records/:id",
    ({ user, params, body, approvalSession }) =>
      service.approve(user.id, params.id, approvalSession, body),
    {
      params: idParam,
      body: personalApprovalInputSchema,
      response: personalApprovalResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalAttemptControl),
      detail: { summary: "Approve the exact reviewed packet for one application attempt" },
    },
  )
  .post(
    "/:id/withdraw",
    ({ user, params, body, approvalSession }) =>
      service.withdraw(user.id, params.id, body.recordId, approvalSession, body),
    {
      params: idParam,
      body: personalApprovalWithdrawSchema,
      response: personalApprovalResponseSchema,
      beforeHandle: rateLimit(RATE_LIMITS.personalAttemptControl),
      detail: { summary: "Withdraw approval and fence pending application transmissions" },
    },
  );
