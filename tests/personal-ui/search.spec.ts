import { expect } from "@playwright/test";
import { searchMissingSetupResponse } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

test("no search request happens before the manual button is clicked", async ({ page }) => {
  const panel = page.getByTestId("search");
  const o = observed(page);
  expect(o.searchPosts).toHaveLength(0);
  // Panel renders with the manual-only promise stated and no results.
  await expect(panel.getByText("Manual web search for career-page URL candidates")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Search" })).toBeDisabled();
  // An empty query never enables the button.
  await panel
    .getByRole("button", { name: "Search" })
    .click({ force: true })
    .catch(() => undefined);
  expect(o.searchPosts).toHaveLength(0);
});

test("missing setup states the gap without any spend", async ({ page }) => {
  const o = observed(page);
  o.searchResponse = structuredClone(searchMissingSetupResponse);
  const panel = page.getByTestId("search");

  await panel.getByLabel("Search query").fill("operations analyst careers");
  await panel.getByRole("button", { name: "Search" }).click();
  await expect.poll(() => o.searchPosts.length, { timeout: 5_000 }).toBe(1);
  await expect(panel.getByText("Search is not set up for this account yet.")).toBeVisible();
  // No candidates render and no budget chip claims anything.
  await expect(panel.getByText("Operations Analyst — Example Corp")).toHaveCount(0);
  await expect(panel.getByText(/Unverified snippet/)).toHaveCount(0);
  await expect(panel.getByText(/reserved \$/)).toHaveCount(0);
});

test("partial results stay URL candidates — never eligibility — with local-only budget", async ({
  page,
}) => {
  const o = observed(page);
  const panel = page.getByTestId("search");

  await panel.getByLabel("Search query").fill("pricing manager careers page");
  await panel.getByRole("button", { name: "Search" }).click();
  await expect.poll(() => o.searchPosts.length, { timeout: 5_000 }).toBe(1);
  expect(o.searchPosts[0]?.body).toMatchObject({
    query: "pricing manager careers page",
    maxPages: 3,
    pageSize: 20,
  });

  await expect(
    panel.getByText("Partial results — some pages failed or were refused."),
  ).toBeVisible();
  await expect(panel.getByText("scope: search_query — this query only")).toBeVisible();
  // Local reservations only; the provider's actual bill is explicitly unknown.
  await expect(
    panel.getByText(
      /reserved \$0\.00 of \$5\.00 search \/ \$200\.00 monthly \(local reservations\)/,
    ),
  ).toBeVisible();
  await expect(panel.getByText("the provider's actual bill is unknown to JobPilot")).toBeVisible();

  // Candidates render as unverified URL snippets.
  await expect(panel.getByText("Operations Analyst — Example Corp")).toBeVisible();
  await expect(panel.getByText("Senior Pricing Manager — Example Org")).toBeVisible();
  // Both candidates carry the unverified-snippet caveat (one per row).
  await expect(
    panel.getByText(
      "Unverified snippet — no full description fetched, employer identity unverified.",
    ),
  ).toHaveCount(2);
  await expect(
    panel.getByText("2 observed · 1 invalid · 0 duplicates · 2 pages fetched"),
  ).toBeVisible();
  expectOnlySyntheticTraffic(o, harnessOrigin);
});
