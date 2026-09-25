import { expect } from "@playwright/test";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

test("registry lists sources with honest adapter capability and the read-only policy", async ({
  page,
}) => {
  const registry = page.getByTestId("registry");
  await expect(registry.getByText("greenhouse:syntheticlabs")).toBeVisible();
  // The same Lever identity appears in both the source list and the alias list.
  await expect(registry.getByText("lever:syntheticorg").first()).toBeVisible();
  // The Lever row states its restricted adapter truth: native multipart only, parks custom
  // widgets, and never treats an HTTP 2xx as a confirmed submission.
  await expect(
    registry.getByText("Restricted Lever submit (verified native multipart only)"),
  ).toBeVisible();
  await expect(
    registry.getByText(
      "custom widgets and unsupported flows park; even an HTTP 2xx stays uncertain until reconciled",
    ),
  ).toBeVisible();
  await expect(registry.getByText("Guarded Greenhouse submit")).toBeVisible();

  await expect(registry.getByText("Run policy (read-only)")).toBeVisible();
  await expect(
    registry.getByText("Locally tracked reservations against plan ceilings"),
  ).toBeVisible();
  await expect(registry.getByText("never claims the")).toBeVisible();
  // No mutation control exists anywhere in the panel.
  for (const label of ["Register", "Add source", "Attest", "Save policy", "Edit"]) {
    await expect(registry.getByRole("button", { name: label })).toHaveCount(0);
  }
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("aliases display source and canonical employers with verification, read-only", async ({
  page,
}) => {
  const registry = page.getByTestId("registry");
  await expect(registry.getByText("Employer aliases (read-only)")).toBeVisible();
  // The alias row's source identity (second occurrence: the first is the registry source list).
  await expect(registry.getByText("lever:syntheticorg").nth(1)).toBeVisible();
  await expect(registry.getByText("synthetic.org", { exact: true })).toBeVisible();
  await expect(registry.getByText("greenhouse:legacyco")).toBeVisible();
  await expect(registry.getByText("legacy.example", { exact: true })).toBeVisible();
  // Verification states are distinct and honest.
  await expect(registry.getByText("Owner attested", { exact: true })).toBeVisible();
  await expect(registry.getByText("Legacy unverified", { exact: true })).toBeVisible();
  await expect(
    registry.getByText("replacement is blocked after any attempt or reservation."),
  ).toBeVisible();
  await expect(registry.getByText("Registration is not done from this page.")).toBeVisible();
  // No attestation or mutation control of any kind.
  for (const label of ["Attest", "Add alias", "Replace", "Register", "Edit"]) {
    await expect(registry.getByRole("button", { name: label })).toHaveCount(0);
  }
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("digest is local-only with counter basis, source health, and action blockers", async ({
  page,
}) => {
  const digest = page.getByTestId("digest");
  await expect(digest.getByText("day 2026-09-15")).toBeVisible();
  await expect(digest.getByText("local only", { exact: true })).toBeVisible();
  await expect(
    digest.getByText(
      "New discoveries were created within the reporting window; remaining counters are current record-state totals, not daily transitions.",
    ),
  ).toBeVisible();
  // Counters render as bare numbers (the overline label, distinct from the basis sentence).
  await expect(digest.getByText("New discoveries", { exact: true })).toBeVisible();
  await expect(digest.getByText("4", { exact: true })).toBeVisible();

  // Source health distinguishes complete from stale.
  await expect(digest.getByText("complete", { exact: true })).toBeVisible();
  await expect(digest.getByText("stale", { exact: true })).toBeVisible();
  await expect(digest.getByText("4/4 observed")).toBeVisible();
  await expect(digest.getByText("Coverage is the registered sources above only")).toBeVisible();

  // Action blockers with their kinds.
  await expect(digest.getByText("Ops Intern · Synthetic Logistics")).toBeVisible();
  await expect(digest.getByText("Answers required", { exact: true })).toBeVisible();
  await expect(digest.getByText("Security handoff", { exact: true })).toBeVisible();

  // No tick control ever exists on this panel.
  await expect(digest.getByRole("button", { name: /tick|refresh|create/i })).toHaveCount(0);
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("a missing digest states its absence without inventing one", async ({ page }) => {
  const o = observed(page);
  o.digestResponse = { digest: null };
  const digest = page.getByTestId("digest");
  await expect(digest.getByText("No digest yet.")).toBeVisible();
  await expect(digest.getByText("none is created from this page.")).toBeVisible();
  await expect(digest.getByText("Action blockers")).toHaveCount(0);
});

test("a stale digest warns rather than presenting old numbers as current", async ({ page }) => {
  const o = observed(page);
  const stale = structuredClone(o.digestResponse) as {
    digest: { capturedAt: string; day: string };
  };
  stale.digest.capturedAt = "2026-09-01T07:00:00.000Z";
  stale.digest.day = "2026-09-01";
  o.digestResponse = stale;
  const digest = page.getByTestId("digest");
  await expect(
    digest.getByText("This digest is stale — captured more than a day ago."),
  ).toBeVisible();
  await expect(digest.getByText("day 2026-09-01")).toBeVisible();
});
