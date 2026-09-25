import { boundedInteger, sha256 } from "./common";
import type { ConnectorOptions, ConnectorResult } from "./types";

async function boundedBody(response: Response, maximum: number, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Response exceeds discovery byte limit");
  }
  if (!response.body) return { text: "", bytes: 0, contentHash: sha256("") };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Discovery request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) throw new Error("Response exceeds discovery byte limit");
      chunks.push(item.value);
    }
    const bytes = Buffer.concat(chunks);
    return { text: bytes.toString("utf8"), bytes: length, contentHash: sha256(bytes) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}
function retryDate(header: string | null, now: Date) {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : null;
  const timestamp = seconds === null ? Date.parse(header ?? "") : now.getTime() + seconds * 1000;
  return new Date(
    Number.isFinite(timestamp) && timestamp > now.getTime() && timestamp <= 8.64e15
      ? timestamp
      : now.getTime() + 60_000,
  ).toISOString();
}
export async function fetchPage(url: string, result: ConnectorResult, options: ConnectorOptions) {
  const timeout = boundedInteger(options.timeoutMs, 10_000, 30_000);
  const maximum = boundedInteger(options.maxResponseBytes, 5_000_000, 20_000_000);
  const retries = options.retries ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 2)
    throw new Error("Invalid retry bound");
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let index = 0; index <= retries; index++) {
    if (options.signal?.aborted) {
      result.health.errors.push("Discovery cancelled");
      result.health.lastFailure = "failed";
      return null;
    }
    const receipt = {
      url,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      httpStatus: null as number | null,
      contentHash: null as string | null,
      bytes: null as number | null,
    };
    result.health.receipts.push(receipt);
    result.health.attempts++;
    try {
      const deadline = AbortSignal.timeout(timeout);
      const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
      const response = await (options.fetch ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { accept: "application/json" },
      });
      receipt.httpStatus = response.status;
      result.health.httpStatus = response.status;
      if (response.redirected) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Discovery redirect rejected");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (
          response.status === 429 ||
          (response.status >= 500 && response.headers.has("retry-after"))
        )
          result.health.nextEligibleAt = retryDate(
            response.headers.get("retry-after"),
            options.now?.() ?? new Date(),
          );
        if (response.status >= 500 && !result.health.nextEligibleAt && index < retries) {
          await sleep(250 * 2 ** index);
          continue;
        }
        result.health.lastFailure = [401, 403, 429].includes(response.status)
          ? "blocked"
          : "failed";
        result.health.errors.push(`HTTP ${response.status}`);
        return null;
      }
      const body = await boundedBody(response, maximum, signal);
      receipt.contentHash = body.contentHash;
      receipt.bytes = body.bytes;
      return { payload: JSON.parse(body.text) as unknown, contentHash: receipt.contentHash };
    } catch (error) {
      if (!options.signal?.aborted && index < retries) {
        await sleep(250 * 2 ** index);
        continue;
      }
      result.health.lastFailure = "failed";
      result.health.errors.push(
        error instanceof Error ? error.message : "Discovery request failed",
      );
      return null;
    }
  }
  return null;
}
