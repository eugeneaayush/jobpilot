import { expect } from "@playwright/test";
import { openPreviewDialog } from "./actions";
import { PDF_HASH, previewRecord } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

test("draft and submission-uncertain labels render", async ({ page }) => {
  const records = page.getByTestId("records");
  await expect(records.getByText("Submission uncertain", { exact: true })).toBeVisible();
  const dialog = await openPreviewDialog(page);
  await expect(dialog.getByText("Draft", { exact: true })).toBeVisible();
});

test("offline preview and offline form make no employer requests", async ({ page }) => {
  const dialog = await openPreviewDialog(page);
  await dialog.getByRole("button", { name: "Open offline form" }).click();
  await dialog.getByRole("button", { name: "Close" }).click();

  const o = observed(page);
  expect(o.previewPosts).toEqual(["/api/personal/rec-mba-intern/preview"]);
  expect(o.formPreviewGets).toEqual(["/api/personal/rec-mba-intern/form-preview"]);
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("visual QA stays locked until the exact PDF is opened", async ({ page }) => {
  const dialog = await openPreviewDialog(page);
  const reviewButton = dialog.getByRole("button", { name: "Mark visually reviewed" });
  await expect(reviewButton).toBeDisabled();

  // Notes alone are not enough — only opening the exact PDF unlocks the review.
  await dialog.getByLabel("What you verified").fill("Name and dates render correctly.");
  await expect(reviewButton).toBeDisabled();

  const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  // component="a" makes this an anchor: implicit role "link", not "button".
  await dialog.getByRole("link", { name: "Open exact PDF" }).click();
  await popupPromise;
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();

  const o = observed(page);
  await expect.poll(() => o.renderReviews.length, { timeout: 5_000 }).toBe(1);
  expect(o.renderReviews[0]).toEqual({
    url: "/api/personal/rec-mba-intern/render-review",
    body: { pdfHash: PDF_HASH, inspected: true, notes: "Name and dates render correctly." },
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("Escape closes and clears the exact-PDF review gate", async ({ page }) => {
  const dialog = await openPreviewDialog(page);
  await dialog.getByLabel("What you verified").fill("Synthetic rendered page checked");
  const popup = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open exact PDF" }).click();
  await popup;
  await expect(dialog.getByRole("button", { name: "Mark visually reviewed" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const reopened = await openPreviewDialog(page);
  await expect(reopened.getByLabel("What you verified")).toHaveValue("");
  await expect(reopened.getByRole("button", { name: "Mark visually reviewed" })).toBeDisabled();
});

test("an updated preview resets visual review while the dialog remains open", async ({ page }) => {
  const dialog = await openPreviewDialog(page);
  await dialog.getByLabel("What you verified").fill("Checked the old synthetic PDF");
  const popup = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open exact PDF" }).click();
  await popup;
  await expect(dialog.getByRole("button", { name: "Mark visually reviewed" })).toBeEnabled();
  await page.evaluate(
    (record) => {
      window.dispatchEvent(new CustomEvent("personal-harness-records", { detail: [record] }));
    },
    {
      ...previewRecord,
      updatedAt: "2026-09-15T13:00:00.000Z",
      preview: { ...previewRecord.preview, pdfHash: "d".repeat(64) },
    },
  );
  await expect(dialog.getByLabel("What you verified")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Mark visually reviewed" })).toBeDisabled();
  await expect(dialog.getByText("d".repeat(64), { exact: true })).toBeVisible();
});
