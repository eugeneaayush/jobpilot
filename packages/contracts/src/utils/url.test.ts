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
    expect(normalizeLinkUrl("linkedin.com/in/ada")).toBe("https://linkedin.com/in/ada");
    expect(normalizeLinkUrl("example.com/a:b")).toBe("https://example.com/a:b");
  });

  it("reads a dotted host:port as a bare host, not a scheme", () => {
    expect(normalizeLinkUrl("example.com:8080")).toBe("https://example.com:8080");
    expect(normalizeLinkUrl("www.example.com:443/portfolio")).toBe(
      "https://www.example.com:443/portfolio",
    );
    expect(normalizeLinkUrl("example.com:8080?tab=1")).toBe("https://example.com:8080?tab=1");
  });

  it("drops an undotted name before digits, since tel:911 looks the same as host:port", () => {
    expect(normalizeLinkUrl("tel:911")).toBe("");
    expect(normalizeLinkUrl("sms:12345")).toBe("");
    expect(normalizeLinkUrl("ftp:21")).toBe("");
    expect(normalizeLinkUrl("localhost:3000")).toBe("");
  });

  it("keeps an existing http(s) protocol, case and all, trimming around it", () => {
    expect(normalizeLinkUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeLinkUrl("  https://example.com  ")).toBe("https://example.com");
    expect(normalizeLinkUrl("HTTPS://Example.com")).toBe("HTTPS://Example.com");
  });

  it("drops any other scheme instead of prefixing it", () => {
    expect(normalizeLinkUrl("ftp://example.com")).toBe("");
    expect(normalizeLinkUrl("mailto:a@b.co")).toBe("");
    expect(normalizeLinkUrl("tel:+15551234567")).toBe("");
    expect(normalizeLinkUrl("tel:5551234567")).toBe("");
    expect(normalizeLinkUrl("javascript:alert(1)")).toBe("");
    expect(normalizeLinkUrl("  JavaScript:alert(1)")).toBe("");
    expect(normalizeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe("");
  });

  it("never returns a non-empty value that is not an http(s) URL, since callers render it as an href", () => {
    const hostile = [
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "java\tscript:alert(1)",
      "\u0000javascript:alert(1)",
      "javascript:1",
      "//evil.example",
      "file:///etc/passwd",
    ];
    for (const input of hostile) {
      const result = normalizeLinkUrl(input);
      expect(result === "" || /^https?:\/\//i.test(result)).toBe(true);
    }
  });
});
