import { Elysia } from "elysia";
import { verifyAccessToken } from "@/common/auth";
import { unauthorized } from "@/common/errors";
import { env } from "@/env";
import { requireDashboardOrigin } from "./approval-policy";
import { personalConfiguration } from "./runtime";

export const personalApprovalGuard = new Elysia({
  name: "personal-dashboard-approval-guard",
}).derive({ as: "scoped" }, async ({ headers, cookie, request }) => {
  requireDashboardOrigin(headers, env.CORS_ORIGINS, request.method);
  const token = cookie.accessToken?.value;
  if (typeof token !== "string") throw unauthorized("Dashboard session required");
  const user = await verifyAccessToken(token);
  if (!user) throw unauthorized("Dashboard session required");
  await personalConfiguration(user.id);
  return { user, approvalSession: token };
});
