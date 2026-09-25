import { expect } from "@playwright/test";
import { test } from "./harness";
import { observed } from "./network";

test("three tracks are labeled distinctly", async ({ page }) => {
  const records = page.getByTestId("records");
  // Several rows share a track chip; one visible instance of each label is the claim.
  await expect(records.getByText("MBA internship", { exact: true }).first()).toBeVisible();
  await expect(records.getByText("Post-MBA full-time", { exact: true }).first()).toBeVisible();
  await expect(records.getByText("General professional", { exact: true }).first()).toBeVisible();
});

test("unknown eligibility and fit stay separate verdicts", async ({ page }) => {
  const records = page.getByTestId("records");
  const unknownRow = records.getByRole("row", { name: /Post-MBA Associate/ });
  // Unknown eligibility, no fit score: the Unknown chip and the em-dash must both show.
  await expect(unknownRow.getByText("Unknown", { exact: true })).toBeVisible();
  // The reason lives behind the chip's tooltip — hover to read it.
  await unknownRow.getByText("Unknown", { exact: true }).hover();
  await expect(page.getByText("Work authorization not answered")).toBeVisible();
  // Hard-ineligible with high fit: both columns visible, neither implying the other.
  const ineligibleRow = records.getByRole("row", { name: /Senior Pricing Lead/ });
  await expect(ineligibleRow.getByText("Ineligible")).toBeVisible();
  await expect(ineligibleRow.getByText("91", { exact: true })).toBeVisible();
});

test("source failed reads as failed with its error; empty complete reads as zero records", async ({
  page,
}) => {
  const sources = page.getByTestId("sources");
  await expect(sources.getByText("Complete", { exact: true })).toBeVisible();
  await expect(sources.getByText("0 records")).toBeVisible();
  await expect(sources.getByText("Failed", { exact: true })).toBeVisible();
  await expect(sources.getByText("Board token rejected (404)")).toBeVisible();
});

test("supervisor progress and recent attempts render", async ({ page }) => {
  const attempts = page.getByTestId("attempts");
  await expect(attempts.getByText("running", { exact: true })).toBeVisible();
  await expect(attempts.getByText("supervisor", { exact: true })).toBeVisible();
  // Submit-mode attempts are flagged, offline ones are not; both show their state.
  await expect(attempts.getByText("submission_uncertain", { exact: true })).toBeVisible();
  await expect(attempts.getByText("prepared", { exact: true })).toBeVisible();
  await expect(attempts.getByText("Submit", { exact: true })).toBeVisible();
  await expect(attempts.getByText("Offline", { exact: true })).toBeVisible();
});

test("settings round-trip: untouched facts stay null, currency stated not inferred", async ({
  page,
}) => {
  const settings = page.getByTestId("settings");
  await expect(settings.getByLabel("Graduation year")).toBeVisible();

  await settings.getByLabel("Graduation year").fill("2027");
  await settings.getByLabel("Locations").fill("New York, Boston");
  await settings.getByRole("combobox", { name: "Authorized to work" }).click();
  await page.getByRole("option", { name: "Yes", exact: true }).click();
  await settings.getByLabel("Currency").fill("eur");
  await settings.getByRole("combobox", { name: "Compensation period" }).click();
  await page.getByRole("option", { name: "Per year" }).click();
  await settings.getByRole("button", { name: "Save" }).click();

  const o = observed(page);
  await expect
    .poll(() => o.settingsPut, { timeout: 5_000 })
    .toMatchObject({
      graduationYear: 2027,
      locations: ["New York", "Boston"],
      workAuthorization: true,
      // Typing "eur" upper-cases to EUR; the period is explicit, never defaulted.
      compensationCurrency: "EUR",
      compensationPeriod: "year",
      // The untouched nullable facts must round-trip as null — never false, "" or 0.
      mbaEnrolled: null,
      availableFrom: null,
      availableUntil: null,
      minimumCompensation: null,
      requiresSponsorship: null,
      citizenship: null,
      yearsExperience: null,
      fitThreshold: 70,
      timezone: "America/New_York",
    });
});

test("readiness separates global blockers from per-job questions", async ({ page }) => {
  const readiness = page.getByTestId("readiness");
  await expect(readiness.getByText("Setup not ready", { exact: true })).toBeVisible();
  // The actual approved scope, stated with its consequence.
  await expect(readiness.getByText("Provider scope: Metadata only")).toBeVisible();
  await expect(
    readiness.getByText("The model receives opaque field references", { exact: false }),
  ).toBeVisible();
  await expect(readiness.getByText("Supervisor enabled", { exact: true })).toBeVisible();
  await expect(readiness.getByText("Resume: Conflicted")).toBeVisible();

  await expect(readiness.getByText("Global setup blockers")).toBeVisible();
  await expect(readiness.getByText("Provider approval pending for applicant data")).toBeVisible();
  await expect(readiness.getByText("fitThreshold: Not set in settings.")).toBeVisible();

  await expect(readiness.getByText("Per-job questions", { exact: true })).toBeVisible();
  await expect(readiness.getByText("workAuthorization: Asked on the posting form.")).toBeVisible();
  await expect(
    readiness.getByText("Each posting's form is visited with your explicit answers only."),
  ).toBeVisible();
  await expect(readiness.getByText("Answer these per record")).toBeVisible();
});

test("seniority chips render only for classified records", async ({ page }) => {
  const records = page.getByTestId("records");
  await expect(
    records.getByRole("row", { name: /MBA Intern — Product/ }).getByText("Graduate recruiting"),
  ).toBeVisible();
  await expect(
    records.getByRole("row", { name: /Senior Pricing Lead/ }).getByText("Experienced professional"),
  ).toBeVisible();
  await expect(
    records.getByRole("row", { name: /Warehouse Associate/ }).getByText("Undergraduate entry"),
  ).toBeVisible();
  await expect(
    records.getByRole("row", { name: /Ops Intern/ }).getByText("Seniority unresolved"),
  ).toBeVisible();
  // Absent classification renders no chip, never a guessed one.
  await expect(
    records
      .getByRole("row", { name: /Post-MBA Associate/ })
      .getByText(/Seniority|Graduate|Experienced|Undergraduate/),
  ).toHaveCount(0);
});

test("undergraduate and unresolved classifications block prepare with the reason stated", async ({
  page,
}) => {
  const records = page.getByTestId("records");

  const undergrad = records
    .getByRole("row", { name: /Warehouse Associate/ })
    .getByRole("button", { name: "Preview" });
  await expect(undergrad).toBeDisabled();

  const unresolved = records
    .getByRole("row", { name: /Ops Intern/ })
    .getByRole("button", { name: "Preview" });
  await expect(unresolved).toBeDisabled();

  // Missing classification holds too — matching the backend, never a silent allow.
  const unclassified = records
    .getByRole("row", { name: /Post-MBA Associate/ })
    .getByRole("button", { name: "Preview" });
  await expect(unclassified).toBeDisabled();

  // The API-classified graduate row keeps its preview action.
  const graduate = records
    .getByRole("row", { name: /MBA Intern — Product/ })
    .getByRole("button", { name: "Preview" });
  await expect(graduate).toBeEnabled();
});

test("the seniority dialog shows the API verdict with source evidence", async ({ page }) => {
  const records = page.getByTestId("records");
  await records
    .getByRole("row", { name: /Warehouse Associate/ })
    .getByText("Undergraduate entry")
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Excluded — undergraduate entry")).toBeVisible();
  await expect(
    dialog.getByText("This plan does not pursue entry-level undergraduate roles."),
  ).toBeVisible();
  await expect(dialog.getByText("“No degree or experience required”")).toBeVisible();

  // Unresolved dialog: honest no-evidence copy, never a title-signal claim.
  await dialog.getByRole("button", { name: "Close" }).click();
  await records
    .getByRole("row", { name: /Ops Intern/ })
    .getByText("Seniority unresolved")
    .click();
  await expect(
    dialog.getByText("Needs evidence — no affirmative graduate-level evidence yet."),
  ).toBeVisible();
  await expect(dialog.getByText("No source evidence recorded.")).toBeVisible();
});
