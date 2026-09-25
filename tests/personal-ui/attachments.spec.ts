import { expect, type Page } from "@playwright/test";
import { attachmentsUnknown } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

async function openFiles(page: Page, rowName: RegExp): Promise<ReturnType<typeof page.locator>> {
  const records = page.getByTestId("records");
  await records.getByRole("row", { name: rowName }).getByRole("button", { name: "Files" }).click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Requirements", { exact: true })).toBeVisible();
  return dialog;
}

test("unknown requirements read as unknown, not as none", async ({ page }) => {
  observed(page).attachmentsResponse = structuredClone(attachmentsUnknown);
  const dialog = await openFiles(page, /Senior Pricing Lead/);
  await expect(dialog.getByText("Attachment requirements are unknown")).toBeVisible();
  await expect(dialog.getByText("No attachments required.")).toHaveCount(0);
});

test("requirements list marks required vs optional, and refresh reads public metadata only", async ({
  page,
}) => {
  const dialog = await openFiles(page, /Senior Pricing Lead/);
  // The kind chip and the requirement label both read "Cover letter" — one instance suffices.
  await expect(dialog.getByText("Cover letter", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("required", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Unofficial transcript")).toBeVisible();
  await expect(dialog.getByText("missing cover_letter")).toBeVisible();

  await dialog.getByRole("button", { name: "Refresh from posting" }).click();
  const o = observed(page);
  await expect.poll(() => o.attachmentRefreshes.length, { timeout: 5_000 }).toBe(1);
  expect(o.attachmentRefreshes[0]).toBe(
    "/api/personal/attachments/rec-general-ineligible/requirements/refresh",
  );
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("cover letter drafts from sources and stays a draft until visually reviewed", async ({
  page,
}) => {
  const dialog = await openFiles(page, /Senior Pricing Lead/);
  await dialog.getByRole("button", { name: "Draft cover letter" }).click();

  const o = observed(page);
  await expect.poll(() => o.coverLetterPosts.length, { timeout: 5_000 }).toBe(1);
  expect(o.coverLetterPosts[0]?.body).toEqual({ fieldName: "cover_letter" });

  await expect(dialog.getByText("Review pending", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 source citations")).toBeVisible();
  // Draft blocks readiness even with the requirement filled.
  await expect(dialog.getByText("a document is still a draft pending review")).toBeVisible();
});

test("review requires opening the exact PDF and explicit notes; inspected never auto-sets", async ({
  page,
}) => {
  const dialog = await openFiles(page, /Senior Pricing Lead/);
  await dialog.getByRole("button", { name: "Draft cover letter" }).click();
  await expect(dialog.getByText("Review pending", { exact: true })).toBeVisible();

  const reviewButton = dialog.getByRole("button", { name: "Mark visually reviewed" });
  // Notes alone do not unlock it — only opening the exact PDF does.
  await dialog.getByLabel("What you verified").fill("Name and citations render correctly.");
  await expect(reviewButton).toBeDisabled();

  const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  // component="a" makes this an anchor: implicit role "link".
  await dialog.getByRole("link", { name: "Open exact PDF" }).click();
  await popupPromise;
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();

  const o = observed(page);
  await expect.poll(() => o.attachmentReviews.length, { timeout: 5_000 }).toBe(1);
  expect(o.attachmentReviews[0]?.body).toEqual({
    attachmentId: "77777777-6666-5555-4444-333333333333",
    pdfHash: "7".repeat(64),
    inspected: true,
    notes: "Name and citations render correctly.",
  });
  await expect(dialog.getByText("Review recorded", { exact: true })).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("requiresPreview offers an explicit rerun — never an automatic one", async ({ page }) => {
  const dialog = await openFiles(page, /Senior Pricing Lead/);
  await expect(dialog.getByText("The preview must be rerun")).toBeVisible();

  const o = observed(page);
  expect(o.previewPosts).toHaveLength(0);
  await dialog.getByRole("button", { name: "Rerun offline preview" }).click();
  await expect.poll(() => o.previewPosts.length, { timeout: 5_000 }).toBe(1);
  expect(o.previewPosts[0]).toBe("/api/personal/rec-general-ineligible/preview");
  expectOnlySyntheticTraffic(o, harnessOrigin);
});
