import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCodexTailoring } from "./codex";
import { runCodexClaimReview, runCodexRenderReview } from "./codex-review";
import { protocol, temporary } from "./codex-test-fixtures";
import { sourceFixture, supportedReview } from "./fakes";
import { expect, test } from "bun:test";

const options = (root: string, fake: ReturnType<typeof protocol>) => ({
  runtimeDir: root,
  privateRoot: root,
  approval: { provider: "openai" as const, allowApplicantData: true as const },
  transport: async () => fake.transport,
});
function claimFixture() {
  const { input, proposal } = sourceFixture();
  const {
    reviewer: _,
    reviewedAt: __,
    independent: ___,
    ...response
  } = supportedReview(input, proposal);
  return { input, proposal, response };
}

test("claim review uses a fresh ephemeral session and host identity without trusting proposal self-review", async () =>
  temporary(async (root) => {
    const { input, proposal, response } = claimFixture();
    const author = protocol();
    expect((await runCodexTailoring(input, options(root, author))).status).toBe("proposed");
    const reviewer = protocol("valid", "openai", JSON.stringify(response));
    const result = await runCodexClaimReview(input, proposal, options(root, reviewer));
    expect(result.status).toBe("reviewed");
    if (result.status !== "reviewed") throw new Error("Synthetic claim review failed");
    expect(result.review).toMatchObject({
      sourceDigest: input.sourceDigest,
      inputHash: input.inputHash,
      independent: true,
      claims: response.claims,
    });
    expect(result.review.reviewer).toStartWith("isolated-codex-claim-review:");
    expect(Number.isFinite(Date.parse(result.review.reviewedAt))).toBe(true);
    for (const fake of [author, reviewer]) {
      expect(fake.messages.filter((message) => message.method === "initialize")).toHaveLength(1);
      expect(
        fake.messages.find((message) => message.method === "thread/start")?.params,
      ).toMatchObject({
        ephemeral: true,
        dynamicTools: [],
        approvalPolicy: "never",
      });
      expect(fake.closed()).toBe(true);
    }
    expect((await stat(result.artifactPath)).mode & 0o777).toBe(0o600);
  }));

for (const issue of [
  "unsupported",
  "unknown",
  "missing",
  "duplicate",
  "hash",
  "citation",
  "self_authorize",
])
  test(`claim review holds ${issue} evidence and retains the raw response privately`, async () =>
    temporary(async (root) => {
      const { input, proposal, response } = claimFixture();
      if (issue === "unsupported" || issue === "unknown") response.claims[0]!.decision = issue;
      if (issue === "missing") response.claims = [];
      if (issue === "duplicate") response.claims.push(response.claims[0]!);
      if (issue === "hash") response.proposalHash = "f".repeat(64);
      if (issue === "citation") response.claims[0]!.factIds = ["f".repeat(64)];
      const raw = JSON.stringify(
        issue === "self_authorize" ? { ...response, independent: true } : response,
      );
      const fake = protocol("valid", "openai", raw);
      const result = await runCodexClaimReview(input, proposal, options(root, fake));
      expect(result).toMatchObject({
        status: "blocked",
        diagnostic: { phase: "review_validation", code: "review_validation_failed" },
      });
      expect(await readFile(join(dirname(result.artifactPath!), "raw-proposal.txt"), "utf8")).toBe(
        raw,
      );
    }));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=",
  "base64",
);
const pngHash = createHash("sha256").update(png).digest("hex");
function renderFixture() {
  const input = {
    pdfHash: "d".repeat(64),
    maxPages: 2 as const,
    pageCount: 2,
    textContext: "Synthetic page context, containing no real applicant facts.",
    pages: [1, 2].map((pageNumber) => ({ pageNumber, png, sha256: pngHash })),
  };
  const response = {
    pdfHash: input.pdfHash,
    maxPages: 2,
    decision: "pass",
    pages: [1, 2].map((pageNumber) => ({
      pageNumber,
      imageHash: pngHash,
      decision: "pass",
      findings: ["Synthetic white test image is visible."],
    })),
  };
  return { input, response };
}

test("render review sends actual bytes for every page as embedded images, with no local paths", async () =>
  temporary(async (root) => {
    const { input, response } = renderFixture();
    const fake = protocol("valid", "openai", JSON.stringify(response));
    const result = await runCodexRenderReview(input, options(root, fake));
    expect(result.status).toBe("reviewed");
    if (result.status !== "reviewed") throw new Error("Synthetic render review failed");
    expect(result.review).toMatchObject(response);
    const turn = fake.messages.find((message) => message.method === "turn/start")?.params as {
      input: { type: string; url?: string; path?: string; text?: string }[];
    };
    const images = turn.input.filter((item) => item.type === "image");
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.path).toBeUndefined();
      expect(image.url).toStartWith("data:image/png;base64,");
      expect(Buffer.from(image.url!.split(",")[1]!, "base64")).toEqual(png);
    }
    expect(turn.input[0]!.text).toContain(input.pdfHash);
    expect(turn.input[0]!.text).toContain(pngHash);
  }));

test("visual findings retain an explicit hold rather than becoming a successful render approval", async () =>
  temporary(async (root) => {
    const { input, response } = renderFixture();
    response.decision = "hold";
    response.pages[1]!.decision = "hold";
    response.pages[1]!.findings = ["Text is clipped at the bottom edge."];
    const fake = protocol("valid", "openai", JSON.stringify(response));
    const result = await runCodexRenderReview(input, options(root, fake));
    expect(result).toMatchObject({
      status: "reviewed",
      review: { decision: "hold", pages: response.pages },
    });
  }));

for (const issue of ["missing_page", "hash", "corrupt_png", "page_limit"])
  test(`invalid render input ${issue} cannot reach a provider`, async () =>
    temporary(async (root) => {
      const { input, response } = renderFixture();
      if (issue === "missing_page") input.pages.pop();
      if (issue === "hash") input.pages[0]!.sha256 = "f".repeat(64);
      if (issue === "page_limit") input.pageCount = 3;
      if (issue === "corrupt_png") {
        const corrupt = Buffer.from(png);
        corrupt[45] = corrupt[45]! ^ 255;
        input.pages[0]!.png = corrupt;
        input.pages[0]!.sha256 = createHash("sha256").update(corrupt).digest("hex");
      }
      const fake = protocol("valid", "openai", JSON.stringify(response));
      const result = await runCodexRenderReview(input, options(root, fake));
      expect(result.status).toBe("blocked");
      expect(fake.messages).toHaveLength(0);
    }));

for (const issue of ["pdf_hash", "duplicate_page", "missing_page", "contradiction"])
  test(`render result ${issue} cannot approve a different or incomplete document`, async () =>
    temporary(async (root) => {
      const { input, response } = renderFixture();
      if (issue === "pdf_hash") response.pdfHash = "f".repeat(64);
      if (issue === "duplicate_page") response.pages[1]!.pageNumber = 1;
      if (issue === "missing_page") response.pages.pop();
      if (issue === "contradiction") response.pages[0]!.decision = "hold";
      const fake = protocol("valid", "openai", JSON.stringify(response));
      const result = await runCodexRenderReview(input, options(root, fake));
      expect(result).toMatchObject({
        status: "blocked",
        diagnostic: { code: "review_validation_failed" },
      });
    }));
