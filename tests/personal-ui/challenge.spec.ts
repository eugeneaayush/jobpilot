import { expect } from "@playwright/test";
import { challengeResponse } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

test.setTimeout(45_000);

// One focused test: the whole gated verify path end to end, synthetically.
test("email verification types a one-shot code and reports the verified receipt", async ({
  page,
}) => {
  const attempts = page.getByTestId("attempts");
  await attempts.getByRole("button", { name: "Challenge" }).first().click();
  const dialog = page.locator(".MuiDialog-root");

  // The fence is stated: reserved, not lost; no automatic send or retry.
  await expect(dialog.getByText("This application remains reserved")).toBeVisible();
  await expect(dialog.getByText("awaiting_user", { exact: true })).toBeVisible();
  await expect(dialog.getByText("recipient verified", { exact: true })).toBeVisible();

  const codeField = dialog.getByLabel("Security code");
  const verify = dialog.getByRole("button", { name: "Verify once" });
  // Short codes never enable the single send.
  await codeField.fill("abc12");
  await expect(verify).toBeDisabled();
  await codeField.fill("ab12cd56");
  await expect(verify).toBeEnabled();
  await verify.click();

  const o = observed(page);
  await expect.poll(() => o.challengeVerifies.length, { timeout: 5_000 }).toBe(1);
  // Bearer-authenticated, exact body, and sent exactly once — no replay.
  expect(o.challengeVerifies[0]).toEqual({
    authorized: true,
    body: {
      challengeId: challengeResponse.challenge.challengeId,
      code: "ab12cd56",
    },
  });
  // The code leaves the field the moment the request leaves the browser.
  await expect(codeField).toHaveValue("");

  // Verified outcome names the server-correlated receipt; a public page alone is not one.
  await expect(
    dialog.getByText("the server verified a receipt correlated with your request"),
  ).toBeVisible();
  await expect(dialog.getByText("A public confirmation page alone is not a receipt")).toBeVisible();
  // The evidence-stays-local copy replaces any "never stored" claim.
  await expect(
    dialog.getByText("Protected request evidence stays on this computer."),
  ).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);

  // Closing (Escape/backdrop/Close all share one path) drops any re-typed credential.
  await codeField.fill("zz99zz99");
  await dialog.getByRole("button", { name: "Close" }).click();
  await attempts.getByRole("button", { name: "Challenge" }).first().click();
  await expect(dialog.getByLabel("Security code")).toHaveValue("");
});
