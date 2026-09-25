import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { errorMiddleware } from "@/common/middleware/error.middleware";
import { env } from "@/env";
import { authController } from "@/modules/auth/auth.controller";
import { AuthService } from "@/modules/auth/auth.service";
import { httpErrorResponses } from "@/types/response";
import { personalAttemptController } from "./attempt.controller";
import { personalCampaignController } from "./campaign.controller";
import { personalController } from "./personal.controller";
import { personalAuthGuard } from "./personal.guard";
import { PersonalService } from "./personal.service";
import { personalReadinessController } from "./readiness.controller";
import { personalConfiguration, readSettings } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const app = new Elysia()
  .use(errorMiddleware)
  .guard({ as: "scoped", response: httpErrorResponses })
  .group("/api", (api) =>
    api
      .use(personalController)
      .use(personalAttemptController)
      .use(personalCampaignController)
      .use(personalReadinessController)
      .use(authController),
  )
  .get("/unrelated", () => ({ ok: true }));
const personalRoutes = app.routes.filter((route) => route.path.startsWith("/api/personal"));
const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
const owner = crypto.randomUUID();
const foreign = crypto.randomUUID();
let root: string;
let ownerToken: string;
let foreignToken: string;
const marker = "synthetic-private-source-marker";
const config = {
  account: { userId: owner },
  candidate: { citizenship: marker },
  sourceJsonPath: `/synthetic/${marker}.json`,
  sourceDocxPath: `/synthetic/${marker}.docx`,
};
function request(method: string, path: string, token?: string, body: unknown = {}) {
  return new Request(`http://localhost${path.replace(/:[^/]+/g, crypto.randomUUID())}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method !== "GET" && method !== "HEAD" ? { body: JSON.stringify(body) } : {}),
  });
}

describe("private account source boundary", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "personal-owner-guard-"));
    env.PERSONAL_MODE = true;
    env.JOBPILOT_PERSONAL_ROOT = root;
    await writeFile(join(root, "runtime.json"), JSON.stringify(config), { mode: 0o600 });
    ownerToken = await signAccessToken({ id: owner, email: "owner@example.test", role: "USER" });
    foreignToken = await signAccessToken({
      id: foreign,
      email: "foreign@example.test",
      role: "USER",
    });
  });
  afterAll(async () => {
    Object.assign(env, original);
    await rm(root, { recursive: true, force: true });
  });

  it("denies a valid foreign JWT before every personal handler without source data", async () => {
    expect(personalRoutes.length).toBeGreaterThan(20);
    for (const route of personalRoutes) {
      const response = await app.handle(request(route.method, route.path, foreignToken));
      expect({ route: `${route.method} ${route.path}`, status: response.status }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 403,
      });
      expect(await response.text()).not.toContain(marker);
    }
    expect((await app.handle(request("GET", "/unrelated"))).status).toBe(200);
  });

  it("serves configured-owner settings and refuses anonymous access", async () => {
    const response = await app.handle(request("GET", "/api/personal/settings", ownerToken));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ citizenship: marker });
    expect((await app.handle(request("GET", "/api/personal/settings"))).status).toBe(401);
  });

  it("protects direct source intake and candidate fallback and fails closed without an owner", async () => {
    await expect(readSettings(foreign)).rejects.toThrow("cannot access");
    const service = new PersonalService({} as never, {} as never);
    await expect(service.intake(foreign)).rejects.toThrow("cannot access");
    await writeFile(join(root, "runtime.json"), JSON.stringify({ candidate: config.candidate }));
    await expect(personalConfiguration(owner)).rejects.toThrow("cannot access");
    await writeFile(join(root, "runtime.json"), JSON.stringify(config));
  });

  it("disables password and OAuth account creation while leaving direct setup bootstrap independent", async () => {
    const response = await app.handle(
      request("POST", "/api/auth/register", undefined, {
        email: "new@example.test",
        password: "Synthetic-Password-42!",
      }),
    );
    expect(response.status).toBe(403);
    const auth = new AuthService({} as never);
    await expect(
      auth.createUserAccount({
        email: "oauth@example.test",
        passwordHash: null,
        emailVerified: true,
      }),
    ).rejects.toThrow("personal:setup");
  });

  it("keeps nonpersonal authentication and registration behavior", async () => {
    env.PERSONAL_MODE = false;
    try {
      const ordinary = new Elysia()
        .use(errorMiddleware)
        .use(personalAuthGuard)
        .get("/ordinary", ({ user }) => ({ id: user.id }));
      const response = await ordinary.handle(request("GET", "/ordinary", foreignToken));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: foreign });
      const auth = new AuthService({
        user: {
          findUnique: async () => {
            throw new Error("ordinary-registration-reached-database");
          },
        },
      } as never);
      await expect(
        auth.createUserAccount({
          email: "normal@example.test",
          passwordHash: null,
          emailVerified: true,
        }),
      ).rejects.toThrow("ordinary-registration-reached-database");
    } finally {
      env.PERSONAL_MODE = true;
    }
  });
});
