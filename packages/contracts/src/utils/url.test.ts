import { normalizeLinkUrl } from "./url";
import { describe, expect, it } from "bun:test";

describe("normalizeLinkUrl", () => {
  it("returns an empty string for blank input so optional URL fields can be empty", () => {
    expect(normalizeLinkUrl("")).toBe("");
    expect(normalizeLinkUrl("   ")).toBe("");
  });

  it("prefixes https:// when no protocol is present", () => {
    expect(normalizeLinkUrl("example.com")).toBe("https://example.com");
    expect(normalizeLinkUrl("  example.com/about?q=1  ")).toBe("https://example.com/about?q=1");
    expect(normalizeLinkUrl("例え.jp")).toBe("https://例え.jp");
  });

  it("keeps an existing http(s) protocol, case and all, trimming around it", () => {
    expect(normalizeLinkUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeLinkUrl("  https://example.com  ")).toBe("https://example.com");
    expect(normalizeLinkUrl("HTTPS://Example.com")).toBe("HTTPS://Example.com");
  });
});
