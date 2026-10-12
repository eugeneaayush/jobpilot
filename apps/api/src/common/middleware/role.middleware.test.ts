import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { ApiTokenService } from "@/modules/auth/api-token.service";
import { errorMiddleware } from "./error.middleware";
import { fakeUserDelegate } from "./fakes";
import { requireRole, requireRoleOn } from "./role.middleware";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";

const state = { role: null as string | null };
let restoreUsers: () => void;
let verifyPat: ReturnType<typeof spyOn<ApiTokenService, "verify">>;
beforeAll(() => {
  restoreUsers = fakeUserDelegate(async () => (state.role ? { role: state.role } : null));
  verifyPat = spyOn(ApiTokenService.prototype, "verify").mockResolvedValue(null);
});
afterAll(() => {
  restoreUsers();
  verifyPat.mockRestore();
});

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
  const thrownBy = (check: () => void): unknown => {
    try {
      check();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const forbidden = { status: 403, code: "FORBIDDEN", message: "Insufficient permissions" };

  it("throws forbidden when the route-scoped role is missing", () => {
    expect(thrownBy(() => requireRoleOn("SUPER_ADMIN")(principal("USER")))).toMatchObject(
      forbidden,
    );
    expect(thrownBy(() => requireRoleOn("SUPER_ADMIN")(principal("ADMIN")))).toMatchObject(
      forbidden,
    );
  });

  it("passes holders of the required role - and SUPER_ADMIN above it", () => {
    expect(() => requireRoleOn("ADMIN")(principal("ADMIN"))).not.toThrow();
    expect(() => requireRoleOn("ADMIN")(principal("SUPER_ADMIN"))).not.toThrow();
  });
});
