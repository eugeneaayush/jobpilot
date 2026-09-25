import { expect, type Page } from "@playwright/test";
import { settingsPopulated } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

/** The harness page fetches settings on load, so swap the fixture and reload. */
async function loadPopulated(page: Page): Promise<void> {
  observed(page).settingsResponse = structuredClone(settingsPopulated);
  await page.reload();
  await expect(page.getByTestId("settings").getByLabel("Graduation year")).toHaveValue("2027");
}

test("country scoping and availability notes load from the saved profile", async ({ page }) => {
  await loadPopulated(page);
  const settings = page.getByTestId("settings");
  await expect(settings.getByLabel("Work-authorized countries")).toHaveValue("US, DE");
  await expect(settings.getByLabel("Availability notes")).toHaveValue(
    "Flexible on start timing around the summer window; open to discussing duration.",
  );
  // The labels must scope the claim: countries-only, empty-unknown, no exact dates implied.
  await expect(
    settings.getByText(
      "Your authorization applies only to the countries listed here — empty means unknown.",
    ),
  ).toBeVisible();
  await expect(settings.getByText("it must not state exact dates")).toBeVisible();
});

test("an unrelated save preserves the loaded countries and notes verbatim", async ({ page }) => {
  await loadPopulated(page);
  const settings = page.getByTestId("settings");

  // Touch only one unrelated fact; neither new field is edited.
  await settings.getByLabel("Years of experience").fill("6");
  await settings.getByRole("button", { name: "Save" }).click();

  const o = observed(page);
  await expect.poll(() => o.settingsPut, { timeout: 5_000 }).toBeTruthy();
  expect(o.settingsPut).toMatchObject({
    workAuthorizationCountries: ["US", "DE"],
    availabilityNotes:
      "Flexible on start timing around the summer window; open to discussing duration.",
    yearsExperience: 6,
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("countries uppercase on save and clear to unknown; notes clear to null", async ({ page }) => {
  await loadPopulated(page);
  const settings = page.getByTestId("settings");

  await settings.getByLabel("Work-authorized countries").fill("fr, jp");
  await settings.getByLabel("Availability notes").fill("");
  await settings.getByRole("button", { name: "Save" }).click();

  const o = observed(page);
  await expect.poll(() => o.settingsPut, { timeout: 5_000 }).toBeTruthy();
  expect(o.settingsPut).toMatchObject({
    workAuthorizationCountries: ["FR", "JP"],
    availabilityNotes: null,
  });

  // Clearing the country list round-trips as an explicit empty list — unknown, not worldwide.
  await settings.getByLabel("Work-authorized countries").fill("");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(
      () =>
        (observed(page).settingsPut as { workAuthorizationCountries?: string[] })
          ?.workAuthorizationCountries,
      { timeout: 5_000 },
    )
    .toEqual([]);
});
