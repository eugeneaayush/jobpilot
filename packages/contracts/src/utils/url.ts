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
  // Only a dotted name reads as `host:port` (`example.com:8080`); `tel:911` is a scheme.
  const hostWithPort = /^[a-z\d-]+(?:\.[a-z\d-]+)+:\d{1,5}(?:[/?#]|$)/i;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !hostWithPort.test(trimmed)) {
    return "";
  }
  return `https://${trimmed}`;
}
