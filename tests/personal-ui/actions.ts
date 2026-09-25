import { expect, type Page } from "@playwright/test";

export async function openPreviewDialog(page: Page) {
  const records = page.getByTestId("records");
  await records
    .getByRole("row", { name: /MBA Intern — Product/ })
    .getByRole("button", { name: "Preview" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Offline preview: rendered locally")).toBeVisible();
  return dialog;
}
