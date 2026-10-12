import { SignJWT } from "jose";
import { env } from "@/env";
import {
  durationToMs,
  generateOpaqueToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from "./tokens";
import { describe, expect, it } from "bun:test";

const secret = new TextEncoder().encode(env.JWT_SECRET);

/** A hand-signed HS256 token, so edge-case payloads (no sub, expired) can be crafted. */
function signed(payload: Record<string, unknown>, claims: { sub?: string; exp?: number }) {
  let builder = new SignJWT(payload).setProtectedHeader({ alg: "HS256" });
  if (claims.sub !== undefined) builder = builder.setSubject(claims.sub);
  if (claims.exp !== undefined) builder = builder.setExpirationTime(claims.exp);
  return builder.sign(secret);
}

const future = Math.floor(Date.now() / 1000) + 3600;

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips the principal", async () => {
    const token = await signAccessToken({
      id: "user-1",
      role: "ADMIN",
      email: "user@example.test",
    });

    expect(await verifyAccessToken(token)).toEqual({
      id: "user-1",
      role: "ADMIN",
      email: "user@example.test",
    });
  });

  it("returns null for malformed or tampered tokens", async () => {
    expect(await verifyAccessToken("not-a-jwt")).toBeNull();
    const token = await signAccessToken({ id: "user-1", role: "USER", email: "" });
    expect(await verifyAccessToken(`${token}x`)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const token = await signed({ role: "USER" }, { sub: "user-1", exp: future - 7200 });

    expect(await verifyAccessToken(token)).toBeNull();
  });

  it("returns null when the subject claim is missing", async () => {
    const token = await signed({ role: "USER" }, { exp: future });

    expect(await verifyAccessToken(token)).toBeNull();
  });

  it("defaults the principal when role/email claims are absent", async () => {
    const token = await signed({}, { sub: "user-1", exp: future });

    expect(await verifyAccessToken(token)).toEqual({ id: "user-1", role: "USER", email: "" });
  });
});

describe("generateOpaqueToken", () => {
  it("mints distinct 64-char hex strings", () => {
    const first = generateOpaqueToken();
    const second = generateOpaqueToken();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe("hashToken", () => {
  it("derives a stable 64-char hex digest from the raw token", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
    // Only the digest is ever persisted - never the raw token itself.
    expect(hashToken("abc")).not.toContain("abc");
  });
});

describe("durationToMs", () => {
  it("parses each unit and tolerates surrounding whitespace", () => {
    expect(durationToMs("1s", 0)).toBe(1_000);
    expect(durationToMs("15m", 0)).toBe(900_000);
    expect(durationToMs("2h", 0)).toBe(7_200_000);
    expect(durationToMs("30d", 0)).toBe(2_592_000_000);
    expect(durationToMs(" 10m ", 0)).toBe(600_000);
  });

  it("falls back on anything that is not <number><unit>", () => {
    expect(durationToMs("5w", 42)).toBe(42);
    expect(durationToMs("", 42)).toBe(42);
    expect(durationToMs("soon", 42)).toBe(42);
  });
});
