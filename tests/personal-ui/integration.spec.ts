import { expect, type Page } from "@playwright/test";
import { API, PDF_HASH } from "./fakes";
import { harnessOrigin, test } from "./harness";
import { expectOnlySyntheticTraffic, observed } from "./network";

function packet() {
  return {
    recordId: "rec-mba-intern",
    recordVersion: "2026-09-30T12:00:00.000Z",
    packetHash: "b".repeat(64),
    blockers: [] as string[],
    nonce: "synthetic-session-nonce",
    approval: null as null | {
      id: string;
      status: string;
      approvedAt: string;
      expiresAt: string;
      attemptId: null;
    },
    packet: {
      company: "Synthetic Labs",
      title: "MBA Intern — Product",
      requisitionId: "1001",
      destination: "https://boards.greenhouse.io/syntheticlabs/jobs/1001",
      preparedManifest: {
        document: { sha256: PDF_HASH },
        answers: [{ key: "sponsor", label: "Requires sponsorship", value: true }],
        screeningAnswerSnapshot: {
          answers: [{ key: "sponsor", source: { kind: "explicit_user", confirmed: true } }],
        },
        attachments: [],
      },
      evidence: {
        posting: { descriptionText: "Synthetic official posting evidence" },
        preview: { renderReviewed: true },
        documentVerification: { status: "passed", checks: [] },
      },
    },
  };
}

async function openApproval(page: Page) {
  await page
    .getByTestId("records")
    .getByRole("row", { name: /MBA Intern — Product/ })
    .getByRole("button", { name: "Review application", exact: true })
    .click();
  return page.getByRole("dialog");
}

test("exact application review shows transmission scope, grants with a cookie request, and withdraws", async ({
  page,
}) => {
  const review = packet();
  const posts: unknown[] = [];
  const headers: Record<string, string>[] = [];
  await page.context().route(`${API}/api/personal/approvals/**`, async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      headers.push(route.request().headers());
      review.approval = {
        id: "approved-fixture",
        status: route.request().url().endsWith("/withdraw") ? "withdrawn" : "approved",
        approvedAt: "2026-09-30T12:00:00Z",
        expiresAt: "2026-10-01T00:00:00Z",
        attemptId: null,
      };
    }
    await route.fulfill({ json: review });
  });
  const dialog = await openApproval(page);
  await expect(dialog.getByText(/Fields and uploads can reach the employer before/)).toBeVisible();
  await expect(dialog.getByText("Requires sponsorship", { exact: true })).toBeVisible();
  const approve = dialog.getByRole("button", { name: "Approve this application", exact: true });
  await expect(approve).toBeDisabled();
  const popup = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open exact resume PDF" }).click();
  await popup;
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(dialog.getByRole("button", { name: "Withdraw approval" })).toBeVisible();
  expect(posts[0]).toEqual({
    expectedRecordVersion: review.recordVersion,
    packetHash: review.packetHash,
    nonce: review.nonce,
    confirm: true,
  });
  expect(headers[0]?.authorization).toBeUndefined();
  await dialog.getByRole("button", { name: "Withdraw approval" }).click();
  await expect(dialog.getByText("Approval: withdrawn")).toBeVisible();
  expect(posts).toHaveLength(2);
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});

test("new packet after a stale grant must be opened again", async ({ page }) => {
  const review = packet();
  let posts = 0;
  await page.context().route(`${API}/api/personal/approvals/**`, async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      review.packetHash = "c".repeat(64);
      await route.fulfill({ status: 409, json: { message: "Packet changed" } });
      return;
    }
    await route.fulfill({ json: review });
  });
  const dialog = await openApproval(page);
  const popup = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open exact resume PDF" }).click();
  await popup;
  await dialog.getByRole("button", { name: "Approve this application", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(
    dialog.getByRole("button", { name: "Approve this application", exact: true }),
  ).toBeDisabled();
});

test("verification blockers keep approval disabled after opening the document", async ({
  page,
}) => {
  const review = packet();
  review.blockers = ["Document verification unavailable"];
  await page
    .context()
    .route(`${API}/api/personal/approvals/**`, (route) => route.fulfill({ json: review }));
  const dialog = await openApproval(page);
  await expect(dialog.getByText("Document verification unavailable")).toBeVisible();
  const popup = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open exact resume PDF" }).click();
  await popup;
  await expect(
    dialog.getByRole("button", { name: "Approve this application", exact: true }),
  ).toBeDisabled();
});

test("YAML changes submit a source-bound proposal without applying or approving", async ({
  page,
}) => {
  let submitted: unknown;
  const bundle = {
    recordVersion: "a".repeat(64),
    sourceSha256: "b".repeat(64),
    configSha256: "c".repeat(64),
    rendererVersion: "2.8",
    bundleYaml: "jobpilot: source-bound\ncv: original\n",
  };
  await page.context().route(`${API}/api/personal/rec-mba-intern/resume-yaml`, async (route) => {
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      await route.fulfill({ json: { structuralOperations: 1, requiresIndependentReview: true } });
      return;
    }
    await route.fulfill({ json: bundle });
  });
  await page
    .getByTestId("records")
    .getByRole("row", { name: /MBA Intern — Product/ })
    .getByRole("button", { name: "YAML", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Propose changes" })).toBeDisabled();
  await dialog.getByLabel("JobPilot-produced YAML").fill("jobpilot: source-bound\ncv: selected\n");
  await dialog.getByRole("button", { name: "Propose changes" }).click();
  await expect(dialog.getByText(/Review the proposal before generating/)).toBeVisible();
  expect(submitted).toEqual({
    recordVersion: bundle.recordVersion,
    bundleYaml: "jobpilot: source-bound\ncv: selected\n",
  });
  expectOnlySyntheticTraffic(observed(page), harnessOrigin);
});
