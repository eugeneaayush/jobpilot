import { hashPassword, verifyPassword } from "./password";
import { describe, expect, it } from "bun:test";

describe("password hashing (argon2id)", () => {
  it("round-trips a password through its hash", async () => {
    const hash = await hashPassword("Sup3r-Secret!");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("Sup3r-Secret!", hash)).toBe(true);
  });

  it("rejects a different password", async () => {
    const hash = await hashPassword("Sup3r-Secret!");

    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("salts: two hashes of the same password differ yet both verify", async () => {
    const first = await hashPassword("Sup3r-Secret!");
    const second = await hashPassword("Sup3r-Secret!");

    expect(first).not.toBe(second);
    expect(await verifyPassword("Sup3r-Secret!", first)).toBe(true);
    expect(await verifyPassword("Sup3r-Secret!", second)).toBe(true);
  });
});
