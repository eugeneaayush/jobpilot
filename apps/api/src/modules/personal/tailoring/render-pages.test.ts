import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDraftPdf } from "../document";
import { sourceFixture } from "./fakes";
import { renderReviewPages } from "./render-pages";
import { expect, test } from "bun:test";

test("local visual review renders every frozen PDF page and verifies its exact hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-render-review-"));
  try {
    const fixture = sourceFixture();
    const document = await generateDraftPdf(fixture.data, root, { maxPages: 1 });
    const bytes = await Bun.file(document.path).bytes();
    await expect(
      renderReviewPages(bytes, {
        directory: join(root, "wrong"),
        pdfHash: "0".repeat(64),
        maxPages: 1,
      }),
    ).rejects.toThrow("integrity");
    if (!Bun.which("pdftoppm") || !Bun.which("pdftotext")) return;
    const reviewed = await renderReviewPages(bytes, {
      directory: join(root, "rendered"),
      pdfHash: document.sha256,
      maxPages: 1,
    });
    expect(reviewed.pageCount).toBe(document.pageCount);
    expect(reviewed.pages).toHaveLength(1);
    expect(reviewed.pages[0]!.png.length).toBeGreaterThan(1000);
    expect(reviewed.pages[0]!.sha256).toHaveLength(64);
    expect(reviewed.textContext).toContain("$12M");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
