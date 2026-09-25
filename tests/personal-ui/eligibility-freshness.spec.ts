import { expect, type Page } from "@playwright/test";
import { openPreviewDialog } from "./actions";
import { PDF_HASH, previewRecord } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

/**
 * Eligibility freshness: a stale or unknown-freshness verdict must never render as its decision
 * label ("Eligible"), and document readiness must never read as application readiness. Visual
 * review binds to the exact record id + PDF hash that was opened in the dialog, so a refreshed
 * PDF requires a fresh open before it can be reviewed. All records are synthetic.
 */

const STALE_REASON = "Settings changed after this verdict was recorded";
const UNKNOWN_REASON = "Freshness could not be confirmed after import";

function syntheticRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    campaignId: null,
    identity: "synthetic-identity-freshness",
    requisitionId: null,
    track: "general_professional",
    // "prepared" keeps the State chip label from colliding with the eligibility verdict "Eligible".
    state: "prepared",
    fitScore: 70,
    fitReasons: [],
    eligibility: { decision: "eligible", reasons: ["Synthetic eligibility reason"] },
    missingAnswers: [],
    seniority: null,
    preview: null,
    updatedAt: "2026-09-15T11:00:00.000Z",
    ...overrides,
  };
}

function setRecords(page: Page, detail: unknown[]): Promise<void> {
  return page.evaluate((rows) => {
    window.dispatchEvent(new CustomEvent("personal-harness-records", { detail: rows }));
  }, detail);
}

test("stale and unknown freshness replace the decision label; current and legacy rows do not", async ({
  page,
}) => {
  await setRecords(page, [
    syntheticRecord({
      id: "rec-stale",
      title: "Stale Eligibility Strategist",
      company: "Synthetic Fresh",
      url: "https://example.test/stale",
      eligibilityFreshness: { status: "stale", reason: STALE_REASON },
    }),
    syntheticRecord({
      id: "rec-current",
      title: "Current Ops Associate",
      company: "Synthetic Fresh",
      url: "https://example.test/current",
      eligibilityFreshness: { status: "current", reason: null },
    }),
    syntheticRecord({
      id: "rec-unknown",
      title: "Freshness Unknown PM",
      company: "Synthetic Fresh",
      url: "https://example.test/unknown",
      eligibilityFreshness: { status: "unknown", reason: UNKNOWN_REASON },
    }),
    syntheticRecord({
      id: "rec-legacy",
      title: "MBA Intern — Product",
      company: "Synthetic Labs",
      url: "https://example.test/legacy",
      track: "mba_internship",
      fitScore: 82,
    }),
  ]);
  const records = page.getByTestId("records");

  const staleRow = records.getByRole("row", { name: /Stale Eligibility Strategist/ });
  await expect(staleRow.getByText("Eligibility needs refresh", { exact: true })).toBeVisible();
  await expect(staleRow.getByText("Eligible", { exact: true })).toHaveCount(0);
  await staleRow.getByText("Eligibility needs refresh").hover();
  await expect(page.getByText(STALE_REASON)).toBeVisible();

  const unknownRow = records.getByRole("row", { name: /Freshness Unknown PM/ });
  await expect(
    unknownRow.getByText("Eligibility freshness unknown", { exact: true }),
  ).toBeVisible();
  await expect(unknownRow.getByText("Eligible", { exact: true })).toHaveCount(0);
  await unknownRow.getByText("Eligibility freshness unknown").hover();
  await expect(page.getByText(UNKNOWN_REASON)).toBeVisible();

  const currentRow = records.getByRole("row", { name: /Current Ops Associate/ });
  await expect(currentRow.getByText("Eligible", { exact: true })).toBeVisible();
  await expect(currentRow.getByText(/freshness/i)).toHaveCount(0);

  // Legacy rows without the field render exactly as before: verdict chip, no freshness UI.
  const legacyRow = records.getByRole("row", { name: /MBA Intern — Product/ });
  await expect(legacyRow.getByText("Eligible", { exact: true })).toBeVisible();
  await expect(legacyRow.getByText(/freshness|needs refresh/i)).toHaveCount(0);
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("the preview dialog states stale and unknown freshness with reasons, never the eligible label", async ({
  page,
}) => {
  const dialog = await openPreviewDialog(page);

  await setRecords(page, [
    {
      ...previewRecord,
      updatedAt: "2026-09-17T00:00:00.000Z",
      eligibilityFreshness: { status: "stale", reason: STALE_REASON },
    },
  ]);
  await expect(dialog.getByText(/Eligibility needs refresh — Settings changed/)).toBeVisible();
  await expect(
    dialog.getByText("Document readiness does not make this application ready.", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText("Eligibility: Eligible")).toHaveCount(0);
  // The document chips stay factual: draft readiness is a separate verdict.
  await expect(dialog.getByText("Draft", { exact: true })).toBeVisible();

  await setRecords(page, [
    {
      ...previewRecord,
      updatedAt: "2026-09-17T01:00:00.000Z",
      eligibilityFreshness: { status: "unknown", reason: UNKNOWN_REASON },
    },
  ]);
  await expect(
    dialog.getByText(/Eligibility freshness unknown — Freshness could not be confirmed/),
  ).toBeVisible();
  await expect(dialog.getByText("Eligibility: Eligible")).toHaveCount(0);
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("visual review binds to the exact record and PDF hash that was opened", async ({ page }) => {
  const dialog = await openPreviewDialog(page);
  const reviewButton = () => dialog.getByRole("button", { name: "Mark visually reviewed" });
  await expect(dialog.getByText(PDF_HASH, { exact: true })).toBeVisible();
  await dialog.getByLabel("What you verified").fill("Checked the original synthetic PDF.");
  await expect(reviewButton()).toBeDisabled();

  let popup = page.waitForEvent("popup", { timeout: 5_000 });
  await dialog.getByRole("link", { name: "Open exact PDF" }).click();
  await popup;
  await expect(reviewButton()).toBeEnabled();

  // A refreshed PDF replaces the one that was opened; the stale open cannot review it.
  const refreshedHash = "d".repeat(64);
  await setRecords(page, [
    {
      ...previewRecord,
      updatedAt: "2026-09-17T00:00:00.000Z",
      preview: { ...previewRecord.preview, pdfHash: refreshedHash },
    },
  ]);
  await expect(dialog.getByText(refreshedHash, { exact: true })).toBeVisible();
  await expect(reviewButton()).toBeDisabled();

  // Notes alone cannot review the refreshed PDF — only opening it re-binds the gate.
  await dialog.getByLabel("What you verified").fill("Checked the refreshed synthetic PDF.");
  await expect(reviewButton()).toBeDisabled();
  popup = page.waitForEvent("popup", { timeout: 5_000 });
  await dialog.getByRole("link", { name: "Open exact PDF" }).click();
  await popup;
  await expect(reviewButton()).toBeEnabled();
  await reviewButton().click();

  const o = observed(page);
  await expect.poll(() => o.renderReviews.length, { timeout: 5_000 }).toBe(1);
  expect(o.renderReviews[0]).toEqual({
    url: "/api/personal/rec-mba-intern/render-review",
    body: {
      pdfHash: refreshedHash,
      inspected: true,
      notes: "Checked the refreshed synthetic PDF.",
    },
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});
