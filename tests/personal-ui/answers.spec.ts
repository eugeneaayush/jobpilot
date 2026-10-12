import { expect } from "@playwright/test";
import { NOW } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

test("screening answers require explicit confirmation, never autofill", async ({ page }) => {
  const records = page.getByTestId("records");
  await expect(records.getByText("Submission uncertain", { exact: true })).toBeVisible();
  await records
    .getByRole("row", { name: /MBA Intern/ })
    .getByRole("button", { name: "Answers" })
    .click();
  const dialog = page.locator(".MuiDialog-root");

  // The saved historical snapshot, with its source provenance.
  await expect(dialog.getByText("Saved snapshot")).toBeVisible();
  await expect(dialog.getByText("you confirmed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Requires sponsorship: No")).toBeVisible();
  await expect(
    dialog.getByText("A preview must be generated before these answers take effect"),
  ).toBeVisible();

  // Saved values seed the draft; the unanswered question starts empty — no guess.
  await expect(dialog.getByLabel("Requires sponsorship")).toHaveValue("No");
  await expect(dialog.getByLabel("Authorized to work")).toHaveValue("");

  const save = dialog.getByRole("button", { name: "Save answers" });
  await expect(save).toBeDisabled();
  await dialog.getByLabel("Authorized to work").fill("Yes, authorized");
  await dialog.getByRole("combobox", { name: "Synthetic confirmation" }).click();
  await page.getByRole("option", { name: "Yes / checked" }).click();
  // A filled value alone is still not authorization.
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I confirm these values/ }).check();
  await expect(save).toBeEnabled();
  await save.click();

  const o = observed(page);
  await expect.poll(() => o.answersPosts.length, { timeout: 5_000 }).toBe(1);
  expect(o.answersPosts[0]?.body).toEqual({
    expectedUpdatedAt: NOW,
    answers: [
      {
        key: "requires-sponsorship",
        value: "No",
        label: "Requires sponsorship",
        fieldName: "sponsorship_code",
        source: { kind: "explicit_user", confirmed: true },
      },
      {
        key: "authorization",
        fieldName: "authorization",
        value: "Yes, authorized",
        label: "Authorized to work",
        source: { kind: "explicit_user", confirmed: true },
      },
      {
        key: "confirmed",
        value: true,
        fieldName: "confirmed",
        label: "Synthetic confirmation",
        source: { kind: "explicit_user", confirmed: true },
      },
    ],
  });
  expect(o.answersPosts[0]?.url).toBe("/api/personal/readiness/records/rec-mba-intern/answers");
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("a stale snapshot invalidates the draft instead of overwriting", async ({ page }) => {
  const o = observed(page);
  o.answersPostStatus = 409;

  const records = page.getByTestId("records");
  await records
    .getByRole("row", { name: /MBA Intern/ })
    .getByRole("button", { name: "Answers" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Saved snapshot")).toBeVisible();

  await dialog.getByLabel("Authorized to work").fill("Yes, authorized");
  await dialog.getByRole("checkbox", { name: /I confirm these values/ }).check();
  await dialog.getByRole("button", { name: "Save answers" }).click();

  await expect(dialog.getByText("changed while you were editing")).toBeVisible();
  expect(o.answersPosts.length).toBe(1);
  expect(o.answersPosts[0]?.body).toMatchObject({ expectedUpdatedAt: NOW });
  // Stale means locked: no further save until the latest snapshot is reloaded and re-confirmed.
  await expect(dialog.getByRole("button", { name: "Save answers" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(dialog.getByText("changed while you were editing")).toBeHidden();
  await expect(dialog.getByRole("checkbox", { name: /I confirm these values/ })).not.toBeChecked();
});

test("uncertain applications keep frozen answers locked", async ({ page }) => {
  await page
    .getByTestId("records")
    .getByRole("row", { name: /Post-MBA Associate/ })
    .getByRole("button", { name: "Answers" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(
    dialog.getByText("This application is active or may already be submitted"),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save answers" })).toBeDisabled();
});

test("changed screening question types unset incompatible saved answers", async ({ page }) => {
  const o = observed(page);
  o.answersResponse.questions.push({
    fieldName: "sponsorship_code",
    label: "Requires sponsorship",
    type: "checkbox",
    required: true,
  });
  await page
    .getByTestId("records")
    .getByRole("row", { name: /MBA Intern/ })
    .getByRole("button", { name: "Answers" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await dialog.getByRole("combobox", { name: "Requires sponsorship" }).click();
  await expect(page.getByRole("option", { name: "Not answered", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await dialog.getByRole("checkbox", { name: /I confirm these values/ }).check();
  await dialog.getByRole("button", { name: "Save answers" }).click();
  await expect.poll(() => o.answersPosts.length).toBe(1);
  expect(o.answersPosts[0]?.body).toEqual({ expectedUpdatedAt: NOW, answers: [] });
});

test("clearing every saved answer replaces the snapshot with an empty one", async ({ page }) => {
  const o = observed(page);
  await page
    .getByTestId("records")
    .getByRole("row", { name: /MBA Intern/ })
    .getByRole("button", { name: "Answers" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await dialog.getByLabel("Requires sponsorship").fill("");
  await expect(dialog.getByRole("button", { name: "Save answers" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I confirm these values/ }).check();
  await dialog.getByRole("button", { name: "Save answers" }).click();
  await expect.poll(() => o.answersPosts.length).toBe(1);
  expect(o.answersPosts[0]?.body).toEqual({ expectedUpdatedAt: NOW, answers: [] });
});

test("multiselect saves the complete exact option values only after confirmation", async ({
  page,
}) => {
  const o = observed(page);
  const question = {
    fieldName: "locations",
    label: "Preferred locations",
    type: "select",
    required: true,
    multiple: true,
    options: [
      { value: "ny", label: "New York" },
      { value: "sf", label: "San Francisco" },
      { value: "remote", label: "Remote" },
    ],
  };
  o.answersResponse.questions.push(question);
  await page
    .getByTestId("records")
    .getByRole("row", { name: /MBA Intern/ })
    .getByRole("button", { name: "Answers" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await dialog.getByRole("combobox", { name: "Preferred locations" }).click();
  await page.getByRole("option", { name: "New York", exact: true }).click();
  await page.getByRole("option", { name: "San Francisco", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Save answers" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I confirm these values/ }).check();
  await dialog.getByRole("button", { name: "Save answers" }).click();
  await expect.poll(() => o.answersPosts.length).toBe(1);
  expect(o.answersPosts[0]?.body).toMatchObject({
    answers: expect.arrayContaining([
      {
        key: "locations",
        fieldName: "locations",
        label: "Preferred locations",
        value: ["ny", "sf"],
        source: { kind: "explicit_user", confirmed: true },
      },
    ]),
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});
