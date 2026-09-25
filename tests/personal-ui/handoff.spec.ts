import { expect, type Page } from "@playwright/test";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

async function openHandoff(page: Page): Promise<ReturnType<typeof page.locator>> {
  const attempts = page.getByTestId("attempts");
  await attempts.getByRole("button", { name: "Handoff" }).first().click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Security handoff")).toBeVisible();
  await expect(dialog.getByText("Login required", { exact: true })).toBeVisible();
  return dialog;
}

test("handoff shows the challenge and never claims submission authorization", async ({ page }) => {
  const dialog = await openHandoff(page);
  await expect(dialog.getByText("parked", { exact: true })).toBeVisible();
  await expect(dialog.getByText("browser closed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("https://boards.greenhouse.io")).toBeVisible();
  await expect(dialog.getByText("A handoff does not authorize submission")).toBeVisible();
  await expect(dialog.getByText("Login challenge required")).toBeVisible();
});

test("open is authenticated, bodyless, and marks the browser live", async ({ page }) => {
  const dialog = await openHandoff(page);
  await dialog.getByRole("button", { name: "Open browser for me" }).click();

  const o = observed(page);
  await expect.poll(() => o.handoffActions.length, { timeout: 5_000 }).toBe(1);
  // Bearer-authenticated, no lease body — the host refreshes the lease itself.
  expect(o.handoffActions[0]).toEqual({
    action: "open",
    url: "/workers/handoffs/att-1/open",
    authorized: true,
  });
  expect(o.unauthorizedTerminalCalls).toHaveLength(0);
  await expect(dialog.getByText("open", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("resume stays hidden when the API says open but the host browser is down", async ({
  page,
}) => {
  const o = observed(page);
  // Host restarted: the API still reports open, the browser is actually closed.
  o.handoffResponse = { ...o.handoffResponse, status: "open" };
  o.terminalHandoff = { status: "open", browserOpen: false };

  const dialog = await openHandoff(page);
  await expect(dialog.getByText("browser closed", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("The challenge browser is closed (for example after a host restart)"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resume after challenge" })).toHaveCount(0);
  expect(o.handoffActions).toHaveLength(0);
});

test("an unresolved resume reports the challenge as pending, never resolved", async ({ page }) => {
  const dialog = await openHandoff(page);
  await dialog.getByRole("button", { name: "Open browser for me" }).click();
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Resume after challenge" }).click();
  const o = observed(page);
  await expect.poll(() => o.handoffActions.length, { timeout: 5_000 }).toBe(2);
  expect(o.handoffActions[1]).toEqual({
    action: "resume",
    url: "/workers/handoffs/att-1/resume",
    authorized: true,
  });
  // The DTO says still open — the status chip and the toast message must agree.
  await expect(dialog.getByText("open", { exact: true }).first()).toBeVisible();
  // Toasts render outside the dialog portal; the pending wording is the proof.
  await expect(page.getByText("Resume checked: the challenge remains pending.")).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("a resolved resume closes the browser and reports closure", async ({ page }) => {
  const o = observed(page);
  o.resolveOnResume = true;
  const dialog = await openHandoff(page);
  await dialog.getByRole("button", { name: "Open browser for me" }).click();
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Resume after challenge" }).click();

  await expect.poll(() => o.handoffActions.length, { timeout: 5_000 }).toBe(2);
  await expect(dialog.getByText("resolved", { exact: true })).toBeVisible();
  await expect(dialog.getByText("browser closed", { exact: true })).toBeVisible();
});

test("expired handoffs can be reopened through the terminal", async ({ page }) => {
  const o = observed(page);
  o.handoffResponse = { ...o.handoffResponse, status: "expired" };
  const dialog = await openHandoff(page);
  await expect(dialog.getByText("expired", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Open browser for me" }).click();
  await expect.poll(() => o.handoffActions.length, { timeout: 5_000 }).toBe(1);
  expect(o.handoffActions[0]?.action).toBe("open");
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("a stale token is invalidated once and the next call reacquires", async ({ page }) => {
  const o = observed(page);
  o.expireFirstToken = true;

  const dialog = await openHandoff(page);
  // Both mount-time status lookups consumed the stale first token and were rejected; only
  // one token was ever issued for them because the cache held a single promise.
  expect(o.terminalTokenRequests).toEqual(["expired-terminal-token"]);
  expect(o.unauthorizedTerminalCalls.length).toBeGreaterThanOrEqual(1);
  expect(o.handoffActions).toHaveLength(0);

  // The user's single action acquires a fresh token and succeeds — no auto-replay anywhere.
  await dialog.getByRole("button", { name: "Open browser for me" }).click();
  await expect.poll(() => o.handoffActions.length, { timeout: 5_000 }).toBe(1);
  expect(o.handoffActions[0]?.authorized).toBe(true);
  expect(o.terminalTokenRequests).toEqual(["expired-terminal-token", "synthetic-terminal-token"]);
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("open only claims success when the returned DTO confirms the browser", async ({ page }) => {
  const o = observed(page);
  o.openConfirmsBrowser = false;
  const dialog = await openHandoff(page);

  await dialog.getByRole("button", { name: "Open browser for me" }).click();
  await expect.poll(() => o.handoffActions.length, { timeout: 5_000 }).toBe(1);
  await expect(
    page.getByText("Open requested — the host has not confirmed the browser yet."),
  ).toBeVisible();
  // The DTO said browserOpen false, so the chip must not claim the browser is up.
  await expect(dialog.getByText("browser open", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("browser closed", { exact: true }).first()).toBeVisible();
});

test("refresh status re-reads both views without a reload", async ({ page }) => {
  const o = observed(page);
  const dialog = await openHandoff(page);
  await expect(dialog.getByText("browser closed", { exact: true }).first()).toBeVisible();

  // The host comes back between renders: flip both views, then refresh.
  o.terminalHandoff = { status: "open", browserOpen: true, leaseGeneration: 1 };
  o.handoffResponse = { ...o.handoffResponse, status: "open" };
  await dialog.getByRole("button", { name: "Refresh status" }).click();

  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resume after challenge" })).toBeVisible();
  expect(o.handoffActions).toHaveLength(0);
});

test("an expired lease gates Resume but never blindly disables Cancel", async ({ page }) => {
  const o = observed(page);
  // Lease died while the browser stayed up: status open, browser live, expiry in the past.
  o.handoffResponse = {
    ...o.handoffResponse,
    status: "open",
    leaseExpiresAt: "2026-09-15T00:00:00.000Z",
  };
  o.terminalHandoff = { status: "open", browserOpen: true, leaseGeneration: 1 };

  const dialog = await openHandoff(page);
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  await expect(dialog.getByText("The handoff lease has expired.")).toBeVisible();

  // Resume is not offered on a dead lease (conditionally rendered, not merely disabled).
  await expect(dialog.getByRole("button", { name: "Resume after challenge" })).toHaveCount(0);
  // Cancel is safe cleanup the server accepts on a dead lease — it must stay available.
  await expect(dialog.getByRole("button", { name: "Cancel handoff" })).toBeEnabled();
  expect(o.handoffActions).toHaveLength(0);
});

test("a server-side lease renewal shows a generation mismatch until refreshed", async ({
  page,
}) => {
  const o = observed(page);
  o.handoffResponse = { ...o.handoffResponse, status: "open", leaseGeneration: 1 };
  o.terminalHandoff = { status: "open", browserOpen: true, leaseGeneration: 3 };

  const dialog = await openHandoff(page);
  await expect(dialog.getByText("browser open", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("The lease was renewed server-side (generation 3 vs 1 shown)"),
  ).toBeVisible();
  // A stale view must not offer Resume.
  await expect(dialog.getByRole("button", { name: "Resume after challenge" })).toHaveCount(0);

  // The API catches up; refresh loads the current lease and clears the stale view.
  o.handoffResponse = { ...o.handoffResponse, leaseGeneration: 3 };
  await dialog.getByRole("button", { name: "Refresh status" }).click();
  await expect(
    dialog.getByText("The lease was renewed server-side (generation 3 vs 1 shown)"),
  ).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Resume after challenge" })).toBeVisible();
  expect(o.handoffActions).toHaveLength(0);
});

test("recovery distinguishes a pre-submit park from a submitted-but-uncertain outcome", async ({
  page,
}) => {
  const o = observed(page);
  const records = page.getByTestId("records");

  // Blocked Ops Intern: parked before any submission.
  await records
    .getByRole("row", { name: /Ops Intern/ })
    .getByRole("button", { name: "Recover" })
    .click();
  let dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Server context (exact)")).toBeVisible();
  await expect(dialog.getByText("Not yet submitted", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // Same fixture with a submit timestamp, opened on the uncertain record: the outcome, not
  // the park, is what is uncertain.
  o.recoveryResponse = {
    ...o.recoveryResponse,
    latestAttempt: {
      ...(o.recoveryResponse.latestAttempt as object),
      submitAt: "2026-09-15T11:55:00.000Z",
    },
  };
  await records
    .getByRole("row", { name: /Post-MBA Associate/ })
    .getByRole("button", { name: "Recover" })
    .click();
  dialog = page.locator(".MuiDialog-root");
  // Regex anchors the match: "Not yet submitted" must not satisfy it case-insensitively.
  await expect(dialog.getByText(/^Submission started /)).toBeVisible();
  await expect(dialog.getByText("confirmation pending")).toBeVisible();
  await expect(dialog.getByText("Not yet submitted", { exact: true })).toHaveCount(0);
  // Uncertain after submission stays reconcile-first regardless.
  await expect(dialog.getByText("Reconcile the outcome first")).toBeVisible();
});
