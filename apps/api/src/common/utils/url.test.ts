import { parseCanonicalUrl } from "./url";
import { describe, expect, it } from "bun:test";

const tracking = (name: string) => name === "utm_source" || name === "fbclid";

describe("parseCanonicalUrl", () => {
  it("canonicalizes host case, www, fragment and parameter order", () => {
    const url = parseCanonicalUrl("HTTPS://WWW.Example.com:443/jobs?b=2&a=1#section", tracking);

    expect(url?.href).toBe("https://example.com/jobs?a=1&b=2");
  });

  it("strips the tracking params the predicate names, keeping the rest", () => {
    const url = parseCanonicalUrl("https://example.com/jobs?id=7&utm_source=x&fbclid=y", tracking);

    expect(url?.search).toBe("?id=7");
  });

  it("leaves a clean url untouched, scheme and trailing slash included", () => {
    const url = parseCanonicalUrl("http://example.com/jobs/42/?ref=linkedin", tracking);

    expect(url?.href).toBe("http://example.com/jobs/42/?ref=linkedin");
  });

  it("returns null for non-http schemes and unparseable input", () => {
    expect(parseCanonicalUrl("ftp://example.com/file", tracking)).toBeNull();
    expect(parseCanonicalUrl("not a url", tracking)).toBeNull();
    expect(parseCanonicalUrl("example.com/jobs", tracking)).toBeNull();
  });
});
