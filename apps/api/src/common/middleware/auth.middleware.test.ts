import { type Cookie, Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { ApiTokenService } from "@/modules/auth/api-token.service";
import { authGuard, resolveAuthUser } from "./auth.middleware";
import { errorMiddleware } from "./error.middleware";
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";

// Spy on the prototype instead of swapping the DI instance: auth.middleware keeps whichever
// instance it resolved first, so a swap leaks into every later file in the shared test process.
let verifyPat: ReturnType<typeof spyOn<ApiTokenService, "verify">>;
beforeAll(() => {
  verifyPat = spyOn(ApiTokenService.prototype, "verify").mockResolvedValue(null);
});
afterEach(() => verifyPat.mockResolvedValue(null));
afterAll(() => verifyPat.mockRestore());

const jwt = () => signAccessToken({ id: "user-1", role: "USER", email: "user@example.test" });

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
    verifyPat.mockResolvedValue({ id: "agent-1", role: "USER", email: "agent@example.test" });

    const user = await resolveAuthUser({
      headers: { authorization: `Bearer ${await jwt()}` },
      cookie: {},
    });

    expect(user).toMatchObject({ id: "user-1" });
  });

  it("falls back to the PAT verifier for a non-JWT bearer", async () => {
    verifyPat.mockResolvedValue({ id: "agent-1", role: "USER", email: "agent@example.test" });

    const user = await resolveAuthUser({
      headers: { authorization: "Bearer raw-pat-token" },
      cookie: {},
    });

    expect(user).toEqual({ id: "agent-1", role: "USER", email: "agent@example.test" });
    expect(verifyPat).toHaveBeenLastCalledWith("raw-pat-token");
  });

  it("returns null when neither the JWT nor the PAT verifier recognizes the token", async () => {
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
