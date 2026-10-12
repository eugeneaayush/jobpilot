import { randomUsername } from "./username";
import { describe, expect, it } from "bun:test";

describe("randomUsername", () => {
  it("matches the word-word-digits shape", () => {
    expect(randomUsername()).toMatch(/^[a-z]+-[a-z]+-[1-9][0-9]{3}$/);
  });

  it("varies across draws", () => {
    const draws = new Set(Array.from({ length: 24 }, () => randomUsername()));

    expect(draws.size).toBeGreaterThan(1);
  });
});
