import { normalizeEmail } from "./email";
import { describe, expect, it } from "bun:test";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  MiXeD@Example.TEST ")).toBe("mixed@example.test");
  });

  it("leaves an already-canonical address untouched", () => {
    expect(normalizeEmail("user@example.test")).toBe("user@example.test");
  });
});
