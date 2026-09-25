import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDraftPdf } from "../document";
import { sourceFixture, supportedReview } from "./fakes";
import { expect, test } from "bun:test";

async function temporary(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-tailored-document-"));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return text;
}

test("reviewed rewrite produces private PDF and escaped standalone DOCX while preserving frozen facts", async () =>
  temporary(async (root) => {
    const { data, input, proposal } = sourceFixture();
    const result = await generateDraftPdf(data, root, {
      requestedMode: "rewrite",
      sourceDigest: input.sourceDigest,
      reviewedProposal: { input, proposal, review: supportedReview(input, proposal) },
    });
    expect(result.tailoringMode).toBe("reviewed_rewrite");
    expect(result.status).toBe("draft");
    expect(result.renderQa).toBe("required");
    expect(result.pageCount).toBe(1);
    expect(result.pageLimitExceeded).toBe(false);
    expect(result.data.education).toEqual(data.education);
    expect(result.data.experience[0]!.title).toBe("Analyst");
    expect(result.docx.status).toBe("generated");
    if (result.docx.status !== "generated") throw new Error("Synthetic zip capability missing");
    expect((await stat(result.docx.path)).mode & 0o777).toBe(0o600);
    const files = await command(["unzip", "-Z1", result.docx.path]);
    expect(files.trim().split("\n").sort()).toEqual(
      ["[Content_Types].xml", "_rels/.rels", "word/document.xml"].sort(),
    );
    const xml = await command(["unzip", "-p", result.docx.path, "word/document.xml"]);
    expect(xml).toContain("Developed SQL reporting for a $12M portfolio");
    expect(xml).toContain("MBA");
    const rels = await command(["unzip", "-p", result.docx.path, "_rels/.rels"]);
    expect(rels).not.toContain("TargetMode");
    expect(rels).toContain('Target="word/document.xml"');
    expect((await readFile(result.path)).subarray(0, 4).toString()).toBe("%PDF");
  }));

test("requested rewrites never silently substitute extractive output", async () =>
  temporary(async (root) => {
    const { data, input, proposal, fact } = sourceFixture();
    await expect(generateDraftPdf(data, root, { requestedMode: "rewrite" })).rejects.toThrow(
      "fallback was not substituted",
    );
    await expect(
      generateDraftPdf(data, root, {
        requestedMode: "rewrite",
        sourceDigest: input.sourceDigest,
        reviewedProposal: { input, proposal },
      }),
    ).rejects.toThrow("independent grounded");
    proposal.rewrites[0]!.text = fact.quote;
    await expect(
      generateDraftPdf(data, root, {
        requestedMode: "rewrite",
        sourceDigest: input.sourceDigest,
        reviewedProposal: { input, proposal },
      }),
    ).rejects.toThrow("no reviewed resume changes");
  }));

test("overflow is explicit and original content survives with no silent truncation", async () =>
  temporary(async (root) => {
    const { data } = sourceFixture();
    data.experience[0]!.bullets = Array.from(
      { length: 160 },
      (_, i) =>
        `Synthetic responsibility ${i}: supported source-backed reporting, analysis, stakeholder review and operational documentation.`,
    );
    data.basics.name = 'Synthetic <Candidate> & "Review"';
    const result = await generateDraftPdf(data, root, { maxPages: 2 });
    expect(result.tailoringMode).toBe("extractive");
    expect(result.pageCount).toBeGreaterThan(2);
    expect(result.pageLimitExceeded).toBe(true);
    expect(result.conflicts).toContain("Resume exceeds the 2-page budget; layout review required");
    expect(result.data.experience[0]!.bullets).toHaveLength(160);
    const info = await command(["pdfinfo", result.path]);
    expect(Number(/Pages:\s+(\d+)/.exec(info)?.[1])).toBe(result.pageCount);
    if (result.docx.status !== "generated") throw new Error("Synthetic zip capability missing");
    const xml = await command(["unzip", "-p", result.docx.path, "word/document.xml"]);
    expect(xml).toContain("Synthetic &lt;Candidate&gt; &amp; &quot;Review&quot;");
    expect(xml).not.toContain("<Candidate>");
  }));
