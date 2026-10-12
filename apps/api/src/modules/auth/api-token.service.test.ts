import { hashToken } from "@/common/auth/tokens";
import { CryptoService, KeyUnrecoverableError } from "@/common/crypto";
import { ApiTokenService } from "./api-token.service";
import { type AuthDbState, makeAuthDb } from "./fakes";
import { describe, expect, it } from "bun:test";

type Row = Record<string, unknown>;

/** Encrypt/decrypt round-trip fake; decrypt rejects anything not produced by encryptFor. */
function makeCrypto(over: Partial<CryptoService> = {}) {
  // Pipe-separated because the context itself contains a colon (e.g. "apiToken:terminal").
  const service = {
    encryptFor: async (userId: string, context: string, value: string) =>
      `cipher|${userId}|${context}|${value}`,
    decryptFor: async (userId: string, context: string, cipher: string) => {
      const parts = cipher.split("|");
      if (parts[0] !== "cipher" || parts[1] !== userId || parts[2] !== context) {
        throw new Error("corrupt ciphertext");
      }
      return parts[3] as string;
    },
  };
  return { ...service, ...over } as unknown as CryptoService;
}

function make() {
  const { db, rows } = makeAuthDb({ users: [{ id: "user-1", role: "ADMIN", email: "a@b.test" }] });
  return { db, rows, service: new ApiTokenService(db, makeCrypto()) };
}

function tokenRow(rows: AuthDbState, raw: string, over: Row = {}) {
  const row = {
    id: `api-token-${rows.apiTokens.length + 1}`,
    userId: "user-1",
    name: "terminal",
    tokenHash: hashToken(raw),
    tokenCipher: null,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(rows.apiTokens.length + 1),
    ...over,
  };
  rows.apiTokens.push(row);
  return row;
}

describe("mint", () => {
  it("shows the raw token exactly once and stores only its hash", async () => {
    const { service, rows } = make();

    const minted = await service.mint("user-1", { name: "ci" });

    expect(minted).toMatchObject({ id: rows.apiTokens[0].id, name: "ci" });
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.apiTokens[0]).toMatchObject({
      userId: "user-1",
      name: "ci",
      tokenHash: hashToken(minted.token),
      tokenCipher: null,
    });
  });
});

describe("getOrCreateTerminalToken", () => {
  it("provisions on first use and returns the stored secret afterwards", async () => {
    const { service, rows } = make();

    const first = await service.getOrCreateTerminalToken("user-1");
    const second = await service.getOrCreateTerminalToken("user-1");

    expect(rows.apiTokens).toHaveLength(1);
    expect(rows.apiTokens[0]).toMatchObject({ name: "terminal", revokedAt: null });
    expect(typeof rows.apiTokens[0].tokenCipher).toBe("string");
    expect(second).toMatchObject({ id: first.id, token: first.token });
  });

  it("rotates a token whose cipher no longer decrypts", async () => {
    const { db, rows } = make();
    const first = await new ApiTokenService(db, makeCrypto()).getOrCreateTerminalToken("user-1");
    const undecryptable = makeCrypto({
      decryptFor: async () => {
        throw new Error("corrupt ciphertext");
      },
    });

    const second = await new ApiTokenService(db, undecryptable).getOrCreateTerminalToken("user-1");

    expect(rows.apiTokens).toHaveLength(2);
    expect(rows.apiTokens[0].revokedAt).toBeInstanceOf(Date);
    expect(second.token).not.toBe(first.token);
  });

  it("rethrows a dead DEK instead of rotating", async () => {
    const { db, rows } = make();
    await new ApiTokenService(db, makeCrypto()).getOrCreateTerminalToken("user-1");
    const deadDek = makeCrypto({
      decryptFor: async () => {
        throw new KeyUnrecoverableError("user-1");
      },
    });

    await expect(
      new ApiTokenService(db, deadDek).getOrCreateTerminalToken("user-1"),
    ).rejects.toBeInstanceOf(KeyUnrecoverableError);
    expect(rows.apiTokens).toHaveLength(1);
    expect(rows.apiTokens[0].revokedAt).toBeNull();
  });

  it("re-mints when the stored token is expired or revoked", async () => {
    const { service, rows } = make();
    tokenRow(rows, "expired-raw", {
      tokenCipher: "cipher|user-1|apiToken:terminal|expired-raw",
      expiresAt: new Date(0),
    });
    tokenRow(rows, "revoked-raw", {
      tokenCipher: "cipher|user-1|apiToken:terminal|revoked-raw",
      revokedAt: new Date(0),
    });

    const minted = await service.getOrCreateTerminalToken("user-1");

    expect(rows.apiTokens).toHaveLength(3);
    expect(minted.token).not.toBe("expired-raw");
    expect(minted.token).not.toBe("revoked-raw");
  });
});

describe("list", () => {
  it("returns only live tokens, newest first, without any hash or cipher", async () => {
    const { service, rows } = make();
    // Out of createdAt order, so neither insertion order nor its reverse passes for the service.
    tokenRow(rows, "a", { name: "middle", createdAt: new Date(2_000) });
    tokenRow(rows, "b", { name: "newest", createdAt: new Date(3_000) });
    tokenRow(rows, "c", { name: "oldest", createdAt: new Date(1_000) });
    tokenRow(rows, "d", { name: "gone", createdAt: new Date(4_000), revokedAt: new Date(0) });

    const listed = await service.list("user-1");

    expect(listed.map((token) => token.name)).toEqual(["newest", "middle", "oldest"]);
    for (const token of listed) {
      expect(token).not.toHaveProperty("tokenHash");
      expect(token).not.toHaveProperty("tokenCipher");
    }
  });
});

describe("revoke", () => {
  it("revokes an owned token", async () => {
    const { service, rows } = make();
    tokenRow(rows, "live-raw", { id: "token-1" });

    await expect(service.revoke("user-1", "token-1")).resolves.toEqual({ ok: true });

    expect(rows.apiTokens[0].revokedAt).toBeInstanceOf(Date);
  });

  it("404s another user's token id", async () => {
    const { service, rows } = make();
    tokenRow(rows, "foreign-raw", { id: "token-1", userId: "user-2" });

    await expect(service.revoke("user-1", "token-1")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Token not found",
    });
  });
});

describe("verify", () => {
  it("resolves the principal and bumps lastUsedAt", async () => {
    const { service, rows } = make();
    const minted = await service.mint("user-1", { name: "agent" });

    const principal = await service.verify(minted.token);

    expect(principal).toEqual({ id: "user-1", role: "ADMIN", email: "a@b.test" });
    expect(rows.apiTokens[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("returns null for unknown, revoked and expired tokens", async () => {
    const { service, rows } = make();
    tokenRow(rows, "revoked-raw", { revokedAt: new Date(0) });
    tokenRow(rows, "expired-raw", { expiresAt: new Date(0) });

    expect(await service.verify("never-issued")).toBeNull();
    expect(await service.verify("revoked-raw")).toBeNull();
    expect(await service.verify("expired-raw")).toBeNull();
  });
});
