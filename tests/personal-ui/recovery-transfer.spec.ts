import { expect, type Page } from "@playwright/test";
import { API, createInputDefaults, NOW, recoveryResponse } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

/**
 * Target-campaign selection for recovery transfer: the dialog must query target-specific
 * evidence, reset anything drafted against the previous target, send the exact selected
 * target/run/context, hold writes on mismatched evidence, and reload on a 409. Every route here
 * is a synthetic overlay installed after the shared harness mocks; POSTs fall through to the
 * shared capture handler, so nothing touches a real API.
 */

const campaignId = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ACTIVE = Array.from({ length: 12 }, (_, index) => ({
  ...createInputDefaults,
  name: `Target run ${index + 1}`,
  id: campaignId(index + 1),
  status: "active" as const,
  policyVersion: "pv-1",
  createdAt: NOW,
  updatedAt: NOW,
  authorization: null,
}));

const TARGET_RUN = "88888888-7777-6666-5555-444444444444";

/** Evidence the server would derive for a specific target campaign (distinct from original). */
const targetEvidence = (id: string) =>
  structuredClone({
    ...recoveryResponse,
    updatedAt: "2026-09-15T13:00:00.000Z",
    context: { ...recoveryResponse.context, evidenceHash: `${"d".repeat(63)}2` },
    requirements: [
      {
        ...recoveryResponse.requirements[0],
        requirement: "MBA enrollment via transferred evidence",
        evidence: "Target campaign already verified enrollment from stored facts.",
      },
      recoveryResponse.requirements[1],
    ],
    recovery: {
      ...recoveryResponse.recovery,
      campaignRunId: TARGET_RUN,
      targetCampaignId: id,
    },
  });

interface TargetState {
  campaignGets: { status: string | null; page: number; limit: number }[];
  recoveryGets: (string | null)[];
  /** Lets a test pin the served evidence regardless of the requested target. */
  pinEvidenceTo: string | null;
  /** The first recover POST answers 409 once, then falls through to the shared 200 handler. */
  conflictOnce: boolean;
  conflicts: number;
}

async function installTargetRoutes(page: Page, state: TargetState): Promise<void> {
  await page.context().route(`${API}/api/personal/campaigns**`, async (route) => {
    const url = new URL(route.request().url());
    const current = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "10");
    state.campaignGets.push({ status: url.searchParams.get("status"), page: current, limit });
    const items = ACTIVE.slice((current - 1) * limit, current * limit);
    await route.fulfill({
      status: 200,
      json: {
        items,
        pagination: {
          page: current,
          limit,
          total: ACTIVE.length,
          totalPages: Math.ceil(ACTIVE.length / limit),
        },
      },
    });
  });
  await page.context().route(`${API}/api/personal/recovery/records/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      const isRecover = new URL(request.url()).pathname.endsWith("/recover");
      if (isRecover && state.conflictOnce) {
        state.conflictOnce = false;
        state.conflicts += 1;
        await route.fulfill({
          status: 409,
          json: { message: "Snapshot changed: expectedUpdatedAt mismatch" },
        });
        return;
      }
      await route.fallback();
      return;
    }
    const target = new URL(request.url()).searchParams.get("targetCampaignId");
    state.recoveryGets.push(target);
    const pinned = state.pinEvidenceTo ?? target;
    await route.fulfill({
      status: 200,
      json: pinned ? targetEvidence(pinned) : structuredClone(recoveryResponse),
    });
  });
}

async function openRecovery(page: Page, rowName: RegExp): Promise<ReturnType<typeof page.locator>> {
  const records = page.getByTestId("records");
  await records
    .getByRole("row", { name: rowName })
    .getByRole("button", { name: "Recover" })
    .click();
  const dialog = page.locator(".MuiDialog-root");
  await expect(dialog.getByText("Server context (exact)")).toBeVisible();
  return dialog;
}

async function chooseTarget(page: Page, n: number): Promise<void> {
  const selector = page.locator(".MuiDialog-root").getByLabel("Recovery target campaign");
  await expect(selector).toBeEnabled();
  await selector.click();
  await page.getByRole("option", { name: `Target run ${n} ·` }).click();
  // The target-specific evidence must replace the original view before anything continues.
  await expect(
    page.locator(".MuiDialog-root").getByText("MBA enrollment via transferred evidence", {
      exact: true,
    }),
  ).toBeVisible();
}

function freshState(): TargetState {
  return {
    campaignGets: [],
    recoveryGets: [],
    pinEvidenceTo: null,
    conflictOnce: false,
    conflicts: 0,
  };
}

test("the selector lists active campaigns page by page and never claims completeness", async ({
  page,
}) => {
  const state = freshState();
  await installTargetRoutes(page, state);
  const dialog = await openRecovery(page, /Ops Intern/);

  // Only active campaigns are requested; the default original target stays the first option.
  // (The dashboard's own unfiltered campaigns GET may race in — attribute by the status filter.)
  const selector = dialog.getByLabel("Recovery target campaign");
  await expect(selector).toBeEnabled();
  await selector.click();
  await expect(page.getByRole("option", { name: "Target run 1 ·" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Target run 10 ·" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Target run 11 ·" })).toHaveCount(0);
  await expect(dialog.getByText("Showing 10 of 12 active campaigns.")).toBeVisible();

  await page.getByRole("option", { name: "Original campaign (default)" }).click();
  await dialog.getByRole("button", { name: "Load more campaigns (page 1 of 2)" }).click();
  await selector.click();
  await expect(page.getByRole("option", { name: "Target run 12 ·" })).toBeVisible();
  await expect(dialog.getByText("Showing 12 of 12 active campaigns.")).toBeVisible();
  const targeted = state.campaignGets.filter((get) => get.status === "active");
  expect(targeted.map((get) => get.page)).toEqual([1, 2]);
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("selecting a target re-queries its evidence and resets stale drafts and proof", async ({
  page,
}) => {
  const state = freshState();
  await installTargetRoutes(page, state);
  const dialog = await openRecovery(page, /Ops Intern/);

  // Default evidence: no target in the query, original requirement text.
  expect(state.recoveryGets[0]).toBeNull();
  await expect(dialog.getByText("Current MBA enrollment", { exact: true })).toBeVisible();

  // Stale state drafted against the original target.
  await dialog.getByLabel("Recovery reason").fill("Reason drafted for the original campaign.");
  await dialog.getByRole("button", { name: "Adjudicate eligibility from stored facts…" }).click();
  await dialog.getByLabel("Rationale").first().fill("Rationale drafted for the original target.");
  await dialog.getByLabel("Proof").click();
  await page.getByRole("option", { name: "Screening answers snapshot" }).click();
  await dialog.getByLabel("Snapshot hash").fill("a".repeat(64));

  await chooseTarget(page, 3);

  // The exact selected target went out as the GET query.
  await expect.poll(() => state.recoveryGets[state.recoveryGets.length - 1]).toBe(campaignId(3));
  await expect(dialog.getByText(/Campaign aaaaaaaa/)).toBeVisible();
  await expect(
    dialog.getByText(/Retries inside the already-authorized run 88888888/),
  ).toBeVisible();

  // Everything drafted against the previous evidence is gone.
  await expect(dialog.getByLabel("Recovery reason")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Submit adjudication" })).toHaveCount(0);
  await expect(dialog.getByLabel("Snapshot hash")).toHaveCount(0);
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("writes are held while the shown evidence belongs to a different target", async ({ page }) => {
  const state = freshState();
  state.pinEvidenceTo = campaignId(4);
  await installTargetRoutes(page, state);
  const dialog = await openRecovery(page, /Ops Intern/);

  await chooseTarget(page, 3);
  await expect(dialog.getByText("does not match the selected target campaign")).toBeVisible();
  await dialog.getByLabel("Recovery reason").fill("Should never post from mismatched evidence.");
  await expect(dialog.getByRole("button", { name: "Request recovery" })).toBeDisabled();

  const o = observed(page);
  expect(o.recoveryPosts).toHaveLength(0);
  expect(o.recoveryEligibilityPosts).toHaveLength(0);
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("recover POST carries the exact selected target, run, and context", async ({ page }) => {
  const state = freshState();
  await installTargetRoutes(page, state);
  const dialog = await openRecovery(page, /Ops Intern/);

  await chooseTarget(page, 3);
  await dialog
    .getByLabel("Recovery reason")
    .fill("Transient failure; retry inside the transferred run.");
  await dialog.getByRole("button", { name: "Request recovery" }).click();

  const o = observed(page);
  await expect.poll(() => o.recoveryPosts.length).toBe(1);
  const body = o.recoveryPosts[0]?.body as Record<string, unknown>;
  const served = targetEvidence(campaignId(3));
  expect(body.targetCampaignId).toBe(campaignId(3));
  expect(body.campaignRunId).toBe(TARGET_RUN);
  expect(body.context).toEqual(served.context);
  expect(body.expectedUpdatedAt).toBe(served.updatedAt);
  expect(body.proof).toEqual({ kind: "retry_failure" });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("the default selection keeps the original-campaign POST unchanged", async ({ page }) => {
  const state = freshState();
  await installTargetRoutes(page, state);
  const dialog = await openRecovery(page, /Ops Intern/);

  await dialog.getByLabel("Recovery reason").fill("Transient login failure; retrying same run.");
  await dialog.getByRole("button", { name: "Request recovery" }).click();

  const o = observed(page);
  await expect.poll(() => o.recoveryPosts.length).toBe(1);
  const body = o.recoveryPosts[0]?.body as Record<string, unknown>;
  expect("targetCampaignId" in body).toBe(false);
  expect(body.campaignRunId).toBe(recoveryResponse.recovery.campaignRunId);
  expect(body.context).toEqual(recoveryResponse.context);
  expectOnlySyntheticTraffic(o, harnessOrigin);
});

test("a 409 conflict reloads the target evidence and accepts the retry", async ({ page }) => {
  const state = freshState();
  state.conflictOnce = true;
  await installTargetRoutes(page, state);
  const dialog = await openRecovery(page, /Ops Intern/);

  await chooseTarget(page, 5);
  await dialog.getByLabel("Recovery reason").fill("First attempt races a server-side change.");
  await dialog.getByRole("button", { name: "Request recovery" }).click();

  await expect(page.getByText(/Recovery context changed on the server/)).toBeVisible();
  await expect.poll(() => state.conflicts).toBe(1);
  // The reload re-queried the same target's evidence, not the original campaign's.
  await expect
    .poll(() => state.recoveryGets.filter((target) => target === campaignId(5)).length)
    .toBe(2);

  await dialog.getByRole("button", { name: "Request recovery" }).click();
  const o = observed(page);
  await expect.poll(() => o.recoveryPosts.length).toBe(1);
  expect(o.recoveryPosts[0]?.body).toMatchObject({
    targetCampaignId: campaignId(5),
    campaignRunId: TARGET_RUN,
  });
  expectOnlySyntheticTraffic(o, harnessOrigin);
});
