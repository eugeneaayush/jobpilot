import { expect, type Page } from "@playwright/test";
import { recoveryResponse } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

async function openRecovery(page: Page, rowName: RegExp): Promise<ReturnType<typeof page.locator>> {
  const records = page.getByTestId("records");
  await records
    .getByRole("row", { name: rowName })
    .getByRole("button", { name: "Recover" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Server context (exact)")).toBeVisible();
  return dialog;
}

test("recovery view states requirements, evidence, and the bounded retry window", async ({
  page,
}) => {
  const dialog = await openRecovery(page, /Ops Intern/);
  await expect(dialog.getByText("Current MBA enrollment", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Work authorization in the US", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Unknown", { exact: true }).first()).toBeVisible();
  // Exact server context and window, not client reconstructions.
  await expect(dialog.getByText(/posting a{12}/)).toBeVisible();
  await expect(dialog.getByText("2 left · 1 failed")).toBeVisible();
  await expect(
    dialog.getByText("Retries inside the already-authorized run 99999999"),
  ).toBeVisible();
  // Login-challenge block reason from the latest attempt.
  await expect(dialog.getByText("Login challenge could not complete unattended")).toBeVisible();
});

test("uncertain submissions are reconciliation-first: no recovery write offered", async ({
  page,
}) => {
  const dialog = await openRecovery(page, /Post-MBA Associate/);
  await expect(
    dialog.getByText("Reconcile the outcome first — recovery writes stay"),
  ).toBeVisible();
  await expect(dialog.getByText("Request recovery")).toHaveCount(0);
  await expect(
    dialog.getByText("Recovery stays disabled until the uncertain submission"),
  ).toBeVisible();

  const o = observed(page);
  expect(o.recoveryPosts).toHaveLength(0);
  expect(o.recoveryEligibilityPosts).toHaveLength(0);
});

test("eligibility adjudication cites stored facts and echoes the exact server context", async ({
  page,
}) => {
  const dialog = await openRecovery(page, /Ops Intern/);
  await dialog.getByRole("button", { name: "Adjudicate eligibility from stored facts…" }).click();

  // Requirement 1: stays unknown but still needs a rationale and a verbatim quote.
  await dialog
    .getByLabel("Rationale")
    .first()
    .fill("Posting does not state enrollment verification yet.");
  await dialog
    .getByLabel("Source quote")
    .first()
    .fill("Bachelor's degree or current MBA enrollment required.");

  // Requirement 2: decided, citing a stored settings fact verbatim.
  await dialog
    .getByLabel("Rationale")
    .nth(1)
    .fill("Settings list US as a work-authorized country.");
  await dialog
    .getByLabel("Source quote")
    .nth(1)
    .fill("Applicants must be authorized to work in the United States.");
  await dialog.getByLabel("Your verdict").nth(1).click();
  await page.getByRole("option", { name: "Satisfied" }).click();
  // Citation fields appear only on the decided row — there is exactly one of each.
  await dialog.getByLabel("Stored fact").first().click();
  await page.getByRole("option", { name: "Settings" }).click();
  await dialog.getByLabel("Pointer").first().fill("/workAuthorizationCountries/0");
  await dialog.getByLabel("Stored value").first().fill("US");

  await dialog.getByRole("button", { name: "Submit adjudication" }).click();

  const o = observed(page);
  await expect.poll(() => o.recoveryEligibilityPosts.length, { timeout: 5_000 }).toBe(1);
  const body = o.recoveryEligibilityPosts[0]?.body as {
    expectedUpdatedAt: string;
    context: Record<string, string>;
    decisions: Array<Record<string, unknown>>;
  };
  // The exact server context and update time, echoed — never rebuilt.
  expect(body.context).toEqual(recoveryResponse.context);
  expect(body.expectedUpdatedAt).toBe(recoveryResponse.updatedAt);
  expect(body.decisions).toHaveLength(2);
  expect(body.decisions[1]).toMatchObject({
    requirementId: "2".repeat(64),
    status: "satisfied",
    citation: { kind: "settings", pointer: "/workAuthorizationCountries/0", value: "US" },
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("blocked retry posts one bounded recovery inside the authorized run", async ({ page }) => {
  const dialog = await openRecovery(page, /Ops Intern/);
  await dialog.getByLabel("Recovery reason").fill("Transient login failure; retrying same run.");
  await dialog.getByRole("button", { name: "Request recovery" }).click();

  const o = observed(page);
  await expect.poll(() => o.recoveryPosts.length, { timeout: 5_000 }).toBe(1);
  expect(o.recoveryPosts[0]?.body).toMatchObject({
    expectedUpdatedAt: recoveryResponse.updatedAt,
    attemptId: "11111111-2222-3333-4444-555555555555",
    campaignRunId: "99999999-8888-7777-6666-555555555555",
    reason: "Transient login failure; retrying same run.",
    proof: { kind: "retry_failure" },
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});
