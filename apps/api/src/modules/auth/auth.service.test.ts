import { hashToken, verifyAccessToken } from "@/common/auth/tokens";
import { env } from "@/env";
import { AuthService } from "./auth.service";
import { type AuthDbState, freezeClock, makeAuthDb } from "./fakes";
import { afterEach, describe, expect, it } from "bun:test";

type Row = Record<string, unknown>;

const BASE = Date.parse("2026-10-12T10:00:00.000Z");
const PASSWORD = "Sup3r-Secret!";

let restoreClock: (() => void) | undefined;

const svc = (over: Partial<AuthDbState> = {}) => {
  const { db, rows } = makeAuthDb(over);
  return { service: new AuthService(db), rows };
};

async function seedUser(rows: AuthDbState, over: Row = {}) {
  const user = {
    id: "user-1",
    email: "user@example.test",
    passwordHash: await Bun.password.hash(PASSWORD),
    role: "USER",
    emailVerified: true,
    username: "swift-falcon-1234",
    contactEmail: "user@example.test",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
  rows.users.push(user);
  return user;
}

function refreshRow(rows: AuthDbState, raw: string, over: Row = {}) {
  const row = {
    id: `refresh-${rows.refreshTokens.length + 1}`,
    userId: "user-1",
    tokenHash: hashToken(raw),
    expiresAt: new Date(BASE + 30 * 86_400_000),
    revokedAt: null,
    ...over,
  };
  rows.refreshTokens.push(row);
  return row;
}

const originalEnv = { PERSONAL_MODE: env.PERSONAL_MODE, SUPER_ADMIN_EMAIL: env.SUPER_ADMIN_EMAIL };

afterEach(() => {
  Object.assign(env, originalEnv);
  restoreClock?.();
  restoreClock = undefined;
});

describe("register", () => {
  it("issues a session and persists only the hashed refresh token", async () => {
    restoreClock = freezeClock(BASE);
    const { service, rows } = svc();

    const session = await service.register({ email: " new@Example.test ", password: PASSWORD });

    expect(session.user).toMatchObject({
      email: "new@example.test",
      role: "USER",
      // NODE_ENV is "test" under bun test, so signups start unverified.
      emailVerified: false,
    });
    expect(await verifyAccessToken(session.accessToken)).toMatchObject({
      id: session.user.id,
      role: "USER",
      email: "new@example.test",
    });
    expect(rows.refreshTokens).toHaveLength(1);
    expect(rows.refreshTokens[0]).toMatchObject({
      userId: session.user.id,
      tokenHash: hashToken(session.refreshToken),
      revokedAt: null,
      expiresAt: new Date(BASE + 30 * 86_400_000),
    });
    expect(rows.refreshTokens[0].tokenHash).not.toBe(session.refreshToken);
  });

  it("links the default job boards and a generated username", async () => {
    const { service, rows } = svc({
      jobBoards: [
        { id: "board-default", isDefault: true },
        { id: "board-extra", isDefault: false },
      ],
    });

    await service.register({ email: "boards@example.test", password: PASSWORD });

    expect(rows.userJobBoards.map((link) => link.jobBoardId)).toEqual(["board-default"]);
    expect(typeof rows.users[0].username).toBe("string");
    expect(rows.users[0].contactEmail).toBe("boards@example.test");
  });

  it("rejects an already-registered email with 409, whatever the casing", async () => {
    const { service, rows } = svc();
    await seedUser(rows, { email: "taken@example.test" });

    await expect(
      service.register({ email: "TAKEN@example.test", password: PASSWORD }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT", message: "Email already registered" });
    expect(rows.users).toHaveLength(1);
  });

  it("maps a concurrent unique violation (P2002) to the same 409", async () => {
    const { service, rows } = svc();
    rows.nextCreateError = Object.assign(new Error("unique violation"), { code: "P2002" });

    await expect(
      service.register({ email: "race@example.test", password: PASSWORD }),
    ).rejects.toMatchObject({ status: 409, message: "Email already registered" });
  });

  it("is refused while the server runs in personal mode", async () => {
    env.PERSONAL_MODE = true;
    const { service, rows } = svc();

    await expect(
      service.register({ email: "no@example.test", password: PASSWORD }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(rows.users).toHaveLength(0);
  });

  it("grants SUPER_ADMIN to the configured email, case-insensitively", async () => {
    env.SUPER_ADMIN_EMAIL = "Root@Example.test";
    const { service } = svc();

    const session = await service.register({ email: "root@example.test", password: PASSWORD });

    expect(session.user.role).toBe("SUPER_ADMIN");
  });
});

describe("login", () => {
  it("issues a session for a correct password", async () => {
    const { service, rows } = svc();
    await seedUser(rows);

    const session = await service.login({
      email: " USER@example.TEST ",
      password: PASSWORD,
    });

    expect(await verifyAccessToken(session.accessToken)).toMatchObject({ id: "user-1" });
    expect(rows.refreshTokens).toHaveLength(1);
  });

  it("rejects a wrong password with the generic 401 and no session", async () => {
    const { service, rows } = svc();
    await seedUser(rows);

    await expect(
      service.login({ email: "user@example.test", password: "wrong" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid email or password",
    });
    expect(rows.refreshTokens).toHaveLength(0);
  });

  it("rejects an unknown email with the same generic 401", async () => {
    const { service } = svc();

    await expect(
      service.login({ email: "ghost@example.test", password: PASSWORD }),
    ).rejects.toMatchObject({ status: 401, message: "Invalid email or password" });
  });

  it("rejects an OAuth-only account (null password hash) with the same 401", async () => {
    const { service, rows } = svc();
    await seedUser(rows, { passwordHash: null });

    await expect(
      service.login({ email: "user@example.test", password: PASSWORD }),
    ).rejects.toMatchObject({ status: 401, message: "Invalid email or password" });
  });

  it("still signs in an unverified account - verification is enforced elsewhere, not at login", async () => {
    const { service, rows } = svc();
    await seedUser(rows, { emailVerified: false });

    const session = await service.login({ email: "user@example.test", password: PASSWORD });

    expect(await verifyAccessToken(session.accessToken)).toMatchObject({ id: "user-1" });
  });
});

describe("rotateRefresh", () => {
  it("revokes the old token and issues a fresh pair", async () => {
    const { service, rows } = svc();
    const first = await service.register({ email: "r@example.test", password: PASSWORD });

    const second = await service.rotateRefresh(first.refreshToken);

    const oldRow = rows.refreshTokens.find((t) => t.tokenHash === hashToken(first.refreshToken));
    expect(oldRow?.revokedAt).toBeInstanceOf(Date);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(rows.refreshTokens).toHaveLength(2);
    expect(rows.refreshTokens[1]).toMatchObject({
      tokenHash: hashToken(second.refreshToken),
      revokedAt: null,
    });
    expect(await verifyAccessToken(second.accessToken)).toMatchObject({ id: first.user.id });
  });

  it("rejects reuse of the rotated-out token", async () => {
    const { service } = svc();
    const first = await service.register({ email: "r@example.test", password: PASSWORD });
    await service.rotateRefresh(first.refreshToken);

    await expect(service.rotateRefresh(first.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects empty, unknown and expired tokens", async () => {
    const { service, rows } = svc();
    await seedUser(rows);
    refreshRow(rows, "expired-raw", { expiresAt: new Date(0) });

    await expect(service.rotateRefresh("")).rejects.toMatchObject({
      status: 401,
      message: "Missing refresh token",
    });
    await expect(service.rotateRefresh("unknown-raw")).rejects.toMatchObject({
      status: 401,
      message: "Invalid or expired refresh token",
    });
    await expect(service.rotateRefresh("expired-raw")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a valid token whose user is gone", async () => {
    const { service, rows } = svc();
    refreshRow(rows, "orphan-raw");

    await expect(service.rotateRefresh("orphan-raw")).rejects.toMatchObject({
      status: 401,
      message: "Invalid refresh token",
    });
  });
});

describe("logout", () => {
  it("revokes only the given live token", async () => {
    const { service, rows } = svc();
    refreshRow(rows, "raw-a");
    refreshRow(rows, "raw-b");

    await service.logout("raw-a");

    expect(
      rows.refreshTokens.find((t) => t.tokenHash === hashToken("raw-a"))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      rows.refreshTokens.find((t) => t.tokenHash === hashToken("raw-b"))?.revokedAt,
    ).toBeNull();
  });

  it("is a no-op for an empty or unknown token", async () => {
    const { service } = svc();

    await expect(service.logout("")).resolves.toBeUndefined();
    await expect(service.logout("never-issued")).resolves.toBeUndefined();
  });
});

describe("me", () => {
  it("returns the merged self view with linked providers", async () => {
    const { service, rows } = svc();
    await seedUser(rows);
    rows.oauthAccounts.push({ id: "oa-1", userId: "user-1", provider: "GOOGLE" });

    const me = await service.me("user-1");

    expect(me).toMatchObject({
      id: "user-1",
      email: "user@example.test",
      hasPassword: true,
      username: "swift-falcon-1234",
      providers: ["google"],
    });
  });

  it("404s for an unknown user", async () => {
    const { service } = svc();

    await expect(service.me("ghost")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
