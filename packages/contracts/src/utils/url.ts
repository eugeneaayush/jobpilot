/**
 * Normalizes a user-entered or extracted link to an http(s) URL: trims whitespace, keeps an
 * existing http(s) URL, and prefixes `https://` onto a bare host like `example.com/path`.
 * Returns "" for blank input and for any other scheme (`mailto:`, `ftp:`, `javascript:`), since
 * callers render these links as hrefs and "" keeps optional URL fields representable.
 */
export function normalizeLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // `host:port` also opens with `name:`, so only a `name:` not followed by a port is a scheme.
  if (/^[a-z][a-z\d+.-]*:(?!\d{1,5}(?:[/?#]|$))/i.test(trimmed)) {
    return "";
  }
  return `https://${trimmed}`;
}
