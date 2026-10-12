import { cleanReplacementChars } from "./text";
import { describe, expect, it } from "bun:test";

describe("cleanReplacementChars", () => {
  // Escapes, like the source, keep this file free of literal replacement chars.
  it("restores a dash where an em-dash was mangled into a replacement char", () => {
    expect(cleanReplacementChars("warm\uFFFDup")).toBe("warm-up");
  });

  it("collapses a run of artifacts - raw or Latin-1 misread - into one dash", () => {
    expect(cleanReplacementChars("a\uFFFD\uFFFDb")).toBe("a-b");
    expect(cleanReplacementChars("a\u00EF\u00BF\u00BDb")).toBe("a-b");
    expect(cleanReplacementChars("a\uFFFD\u00EF\u00BF\u00BDb")).toBe("a-b");
  });

  it("leaves undamaged text, including real em-dashes, untouched", () => {
    expect(cleanReplacementChars("")).toBe("");
    expect(cleanReplacementChars("café — déjà")).toBe("café — déjà");
    expect(cleanReplacementChars("plain text")).toBe("plain text");
  });
});
