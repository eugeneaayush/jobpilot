import { LocalHttpError, type RuntimeConfig } from "./common";

export interface DigestPollState {
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastStatus?: "created" | "not_due" | "already_created" | "unavailable";
}
export async function tickDigest(
  config: RuntimeConfig,
  state: DigestPollState,
  persist: () => Promise<void>,
  now = Date.now(),
): Promise<void> {
  if (now < (state.nextCheckAt ?? 0)) return;
  state.lastCheckAt = now;
  state.nextCheckAt = now + 60_000;
  await persist(); // A restart cannot immediately repeat the request after a lost response.
  try {
    const response = await fetch("http://localhost:4101/api/personal/digest/tick", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.account.token}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new LocalHttpError(
        response.status,
        "api",
        "/personal/digest/tick",
        "POST",
        response.headers.get("retry-after"),
      );
    const result = (await response.json()) as { status?: string };
    state.lastStatus = ["created", "not_due", "already_created"].includes(result.status ?? "")
      ? (result.status as "created" | "not_due" | "already_created")
      : "unavailable";
  } catch (error) {
    state.lastStatus = "unavailable";
    if (error instanceof LocalHttpError && error.retryAt !== undefined)
      state.nextCheckAt = Math.max(state.nextCheckAt, error.retryAt);
  }
  await persist();
}
