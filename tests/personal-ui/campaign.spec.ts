import { expect } from "@playwright/test";
import { createInputDefaults } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

test("campaign defaults offline/stopped; launch is one explicit authorization", async ({
  page,
}) => {
  const campaigns = page.getByTestId("campaigns");
  await expect(campaigns.getByText("No campaigns yet.")).toBeVisible();

  await campaigns.getByLabel("Name").fill("Synthetic run");
  await campaigns.getByLabel("Board token").fill("synthboards1");
  await campaigns.getByRole("button", { name: "Create (stopped)" }).click();

  await expect(campaigns.getByText("Synthetic run", { exact: true })).toBeVisible();
  await expect(campaigns.getByText("Stopped", { exact: true })).toBeVisible();

  await campaigns.getByRole("button", { name: "Review & launch" }).click();
  const dialog = page.locator(".MuiDialog-root");
  // The full operating envelope, stated before the single authorization.
  await expect(dialog.getByText("Offline mode: the run prepares previews")).toBeVisible();
  for (const label of ["Mode", "Sources", "Tracks", "Daily cap", "Max applications", "Timezone"]) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  }
  // Ranking is stated as descending score with no cutoff — and no threshold control exists.
  await expect(dialog.getByText("Fit ranking", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Descending score — no cutoff")).toBeVisible();
  await expect(campaigns.getByLabel("Fit priority ≥")).toHaveCount(0);
  await expect(campaigns.getByLabel("Fit threshold")).toHaveCount(0);
  await expect(dialog.getByText("synthboards1")).toBeVisible();

  await dialog.getByRole("button", { name: "Launch campaign" }).click();
  await expect(campaigns.getByText("Active", { exact: true })).toBeVisible();

  await campaigns.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(campaigns.getByText("Stopped", { exact: true })).toBeVisible();

  const o = observed(page);
  expect(o.campaignCreate).toMatchObject(createInputDefaults);
  expect(o.campaignLaunch).toMatchObject({
    url: "/api/personal/campaigns/cmp-synthetic-1/launch",
    body: { confirm: true },
  });
  await expect
    .poll(() => o.campaignStop?.url, { timeout: 5_000 })
    .toBe("/api/personal/campaigns/cmp-synthetic-1/stop");
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("unscoped campaign keeps legacy defaults and omits roleScope", async ({ page }) => {
  const campaigns = page.getByTestId("campaigns");
  await campaigns.getByLabel("Name").fill("Legacy run");
  await campaigns.getByLabel("Board token").fill("synthboards1");
  await campaigns.getByRole("button", { name: "Create (stopped)" }).click();

  const o = observed(page);
  await expect.poll(() => o.campaignCreate, { timeout: 5_000 }).toBeTruthy();
  expect(o.campaignCreate).toMatchObject({ ...createInputDefaults, name: "Legacy run" });
  // Absent, not null/false placeholders — and no scope chip on the saved row.
  expect((o.campaignCreate as Record<string, unknown>).roleScope).toBeUndefined();
  await expect(campaigns.getByText(/categories/)).toHaveCount(0);
});

test("role scope persists and is restated before the single launch authorization", async ({
  page,
}) => {
  const campaigns = page.getByTestId("campaigns");
  await campaigns.getByLabel("Name").fill("Scoped run");
  await campaigns.getByLabel("Board token").fill("synthboards1");
  await campaigns.getByRole("checkbox", { name: "Internship roles only" }).check();
  await campaigns.getByRole("checkbox", { name: "Tech product management" }).check();
  await campaigns.getByRole("checkbox", { name: "Buy-side investing" }).check();
  await campaigns.getByRole("button", { name: "Create (stopped)" }).click();

  const o = observed(page);
  await expect.poll(() => o.campaignCreate, { timeout: 5_000 }).toBeTruthy();
  expect(o.campaignCreate).toMatchObject({
    roleScope: {
      internshipOnly: true,
      categories: ["tech_product_management", "buy_side_investing"],
    },
  });

  // The saved scope is visible on the row…
  await expect(campaigns.getByText("Internships only · 2 categories")).toBeVisible();
  // …and restated in full before the one launch authorization.
  await campaigns.getByRole("button", { name: "Review & launch" }).click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Role scope", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Internships only · Tech product management, Buy-side investing"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Launch campaign" }).click();
  await expect(campaigns.getByText("Active", { exact: true })).toBeVisible();
  // Scope survives launch; still a single confirm for the whole run.
  await expect(campaigns.getByText("Internships only · 2 categories")).toBeVisible();
  expect(o.campaignLaunch).toMatchObject({ body: { confirm: true } });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("internship-only without categories is blocked and posts nothing", async ({ page }) => {
  const campaigns = page.getByTestId("campaigns");
  await campaigns.getByLabel("Name").fill("Bad scope");
  await campaigns.getByLabel("Board token").fill("synthboards1");
  const create = campaigns.getByRole("button", { name: "Create (stopped)" });
  await expect(create).toBeEnabled();

  await campaigns.getByRole("checkbox", { name: "Internship roles only" }).check();
  await expect(create).toBeDisabled();
  await expect(
    campaigns.getByText("Pick at least one category to scope internships.", { exact: true }),
  ).toBeVisible();

  const o = observed(page);
  expect(o.campaignCreate).toBeUndefined();

  // Picking a category releases the gate.
  await campaigns.getByRole("checkbox", { name: "MBB consulting" }).check();
  await expect(create).toBeEnabled();
});
