import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { container } from "@/common/di/container";
import { ApiTokenService } from "@/modules/auth/api-token.service";
import { patApiTokenStub } from "@/modules/auth/fakes";
import { errorMiddleware } from "./error.middleware";
import { describe, expect, it, mock } from "bun:test";

// Both registered before the import below: role.middleware reads the db singleton directly and
// pulls in auth.middleware, whose module-level container.resolve must not bind a real PrismaClient.
const state = { role: null as string | null };
mock.module("@/common/database/prisma.client", () => ({
  db: { user: { findUnique: async () => (state.role ? { role: state.role } : null) } },
}));
container.registerInstance(ApiTokenService, patApiTokenStub);
const { requireRole, requireRoleOn } = await import("./role.middleware");

const jwt = (role: string) => signAccessToken({ id: "user-1", role, email: "user@example.test" });

const adminRoutes = () =>
  new Elysia()
    .use(errorMiddleware)
    .use(requireRole("ADMIN"))
    .get("/admin", ({ user }) => ({ id: user.id, role: user.role }));

// Structural on purpose: the full Elysia generic would not match across plugin compositions.
const call = (app: { handle: (request: Request) => Promise<Response> }, token?: string) =>
  app.handle(
    new Request(
      "http://localhost/admin",
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    ),
  );

describe("requireRole", () => {
  it("401s an anonymous request", async () => {
    expect((await call(adminRoutes())).status).toBe(401);
  });

  it("403s a USER claim outright, even when the row says ADMIN", async () => {
    state.role = "ADMIN";
    const response = await call(adminRoutes(), await jwt("USER"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("admits an ADMIN claim confirmed by the row", async () => {
    state.role = "ADMIN";
    const response = await call(adminRoutes(), await jwt("ADMIN"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "user-1", role: "ADMIN" });
  });

  it("locks out an admin demoted since their token was minted", async () => {
    state.role = "USER";
    expect((await call(adminRoutes(), await jwt("ADMIN"))).status).toBe(403);
  });

  it("locks out an admin whose row is gone", async () => {
    state.role = null;
    expect((await call(adminRoutes(), await jwt("ADMIN"))).status).toBe(403);
  });

  it("serves the row's role, not the possibly-stale claim", async () => {
    state.role = "SUPER_ADMIN";
    const response = await call(adminRoutes(), await jwt("ADMIN"));

    expect(await response.json()).toEqual({ id: "user-1", role: "SUPER_ADMIN" });
  });

  it("lets SUPER_ADMIN satisfy an ADMIN requirement", async () => {
    state.role = "SUPER_ADMIN";
    expect((await call(adminRoutes(), await jwt("SUPER_ADMIN"))).status).toBe(200);
  });
});

describe("requireRoleOn", () => {
  const principal = (role: string) => ({
    user: { id: "user-1", role, email: "user@example.test" },
  });

  it("throws forbidden when the route-scoped role is missing", () => {
    expect(() => requireRoleOn("SUPER_ADMIN")(principal("USER"))).toThrow();
    expect(() => requireRoleOn("SUPER_ADMIN")(principal("ADMIN"))).toThrow();
  });

  it("passes holders of the required role - and SUPER_ADMIN above it", () => {
    expect(() => requireRoleOn("ADMIN")(principal("ADMIN"))).not.toThrow();
    expect(() => requireRoleOn("ADMIN")(principal("SUPER_ADMIN"))).not.toThrow();
  });
});
