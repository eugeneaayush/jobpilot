import { Elysia } from "elysia";
import type { AuthUser } from "@/common/auth";
import { unauthorized } from "@/common/errors";
import { resolveAuthUser } from "@/common/middleware/auth.middleware";
import { env } from "@/env";
import { personalConfiguration } from "./runtime";

/** Private source files belong to the configured account, not every local signed-in account. */
export const personalAuthGuard = new Elysia({ name: "personal-owner-guard" }).derive(
  { as: "scoped" },
  async ({ headers, cookie }): Promise<{ user: AuthUser }> => {
    const user = await resolveAuthUser({ headers, cookie });
    if (!user) throw unauthorized("Missing authorization");
    if (env.PERSONAL_MODE) await personalConfiguration(user.id);
    return { user };
  },
);
