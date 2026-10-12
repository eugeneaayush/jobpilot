import { type Cookie, Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { container } from "@/common/di/container";
import { ApiTokenService } from "@/modules/auth/api-token.service";
import { patApiTokenStub, stubPatVerify } from "@/modules/auth/fakes";
import { errorMiddleware } from "./error.middleware";
import { afterEach, describe, expect, it } from "bun:test";

// Registered before the import below: auth.middleware resolves ApiTokenService from the
// container once at module load, and this file is the first to load it in the test process.
container.registerInstance(ApiTokenService, patApiTokenStub);
const { authGuard, resolveAuthUser } = await import("./auth.middleware");

const jwt = () => signAccessToken({ id: "user-1", role: "USER", email: "user@example.test" });

afterEach(() => stubPatVerify(async () => null));

describe("resolveAuthUser", () => {
  it("returns null for an anonymous request", async () => {
    expect(await resolveAuthUser({ headers: {}, cookie: {} })).toBeNull();
  });

  it("resolves a bearer access JWT", async () => {
    const user = await resolveAuthUser({
      headers: { authorization: `Bearer ${await jwt()}` },
      cookie: {},
    });

    expect(user).toEqual({ id: "user-1", role: "USER", email: "user@example.test" });
  });

  it("resolves the httpOnly accessToken cookie when no header is present", async () => {
    const token = await jwt();

    const user = await resolveAuthUser({
      headers: {},
      cookie: { accessToken: { value: token } as Cookie<unknown> },
    });

    expect(user).toMatchObject({ id: "user-1" });
  });

  it("prefers the JWT over a PAT when the bearer is a valid access token", async () => {
    stubPatVerify(async () => ({ id: "agent-1", role: "USER", email: "agent@example.test" }));

    const user = await resolveAuthUser({
      headers: { authorization: `Bearer ${await jwt()}` },
      cookie: {},
    });

    expect(user).toMatchObject({ id: "user-1" });
  });

  it("falls back to the PAT verifier for a non-JWT bearer", async () => {
    let seen: string | undefined;
    stubPatVerify(async (raw) => {
      seen = raw;
      return { id: "agent-1", role: "USER", email: "agent@example.test" };
    });

    const user = await resolveAuthUser({
      headers: { authorization: "Bearer raw-pat-token" },
      cookie: {},
    });

    expect(user).toEqual({ id: "agent-1", role: "USER", email: "agent@example.test" });
    expect(seen).toBe("raw-pat-token");
  });

  it("returns null when neither the JWT nor the PAT verifier recognizes the token", async () => {
    stubPatVerify(async () => null);

    expect(
      await resolveAuthUser({ headers: { authorization: "Bearer junk" }, cookie: {} }),
    ).toBeNull();
  });
});

describe("authGuard", () => {
  const app = new Elysia()
    .use(errorMiddleware)
    .use(authGuard)
    .get("/whoami", ({ user }) => ({ id: user.id }));

  it("derives user for a bearer JWT", async () => {
    const response = await app.handle(
      new Request("http://localhost/whoami", {
        headers: { authorization: `Bearer ${await jwt()}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "user-1" });
  });

  it("rejects an anonymous request with 401", async () => {
    const response = await app.handle(new Request("http://localhost/whoami"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
