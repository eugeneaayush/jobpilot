import { slugify } from "./slug";
import { describe, expect, it } from "bun:test";

describe("slugify", () => {
  it("lowercases and collapses separator runs", () => {
    expect(slugify("Hello, World! Friends")).toBe("hello-world-friends");
  });

  it("strips non-ascii letters", () => {
    expect(slugify("Café Résumé!")).toBe("caf-r-sum");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("--edge--")).toBe("edge");
  });

  it("truncates and drops the dangling separator the cut can leave", () => {
    expect(slugify("aaaa-bbbb-cccc", { maxLength: 10 })).toBe("aaaa-bbbb");
  });

  it("falls back when nothing survives", () => {
    expect(slugify("!!!", { fallback: "untitled" })).toBe("untitled");
    expect(slugify("!!!")).toBe("");
  });

  it("caps at 60 characters by default", () => {
    const slug = slugify("a".repeat(100));

    expect(slug).toHaveLength(60);
  });
});
