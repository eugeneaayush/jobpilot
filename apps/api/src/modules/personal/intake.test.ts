import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeMaster } from "./intake";
import { describe, expect, test } from "bun:test";

describe("private source intake", () => {
  test("preserves source bytes, all additional information, provenance and conflicting assertions", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "intake-test-"));
    try {
      const source = {
        name: "Synthetic Candidate",
        contact: { email: "test@example.com" },
        education: [
          {
            institution: "Test School",
            degree: "MBA",
            dates: "2026 – 2028",
            bullets: ["Test score 755"],
          },
        ],
        experience: [
          {
            company: "Test Co",
            title: "Analyst",
            start_date: "2020-01",
            end_date: "2022-05",
            bullets: ["Managed $12M", "Built reporting"],
          },
        ],
        additional: {
          lines: [
            { label: "Languages", text: "English" },
            { label: "Interests", text: "Music" },
          ],
        },
        customResearch: { title: "Synthetic research" },
      };
      const json = join(temporary, "master.json");
      const docx = join(temporary, "master.docx");
      const comparison = join(temporary, "other.json");
      const bytes = JSON.stringify(source);
      await writeFile(json, bytes);
      await writeFile(comparison, JSON.stringify({ name: "Other name" }));
      await mkdir(join(temporary, "word"));
      await writeFile(
        join(temporary, "word/document.xml"),
        '<w:document xmlns:w="test"><w:body><w:p><w:r><w:t>Synthetic Candidate</w:t></w:r></w:p><w:p><w:r><w:t>Test score 755</w:t></w:r></w:p><w:p><w:r><w:t>Managed $12M</w:t></w:r></w:p></w:body></w:document>',
      );
      expect(
        await Bun.spawn(["zip", "-q", docx, "word/document.xml"], { cwd: temporary }).exited,
      ).toBe(0);
      const originalDocx = await readFile(docx);
      const result = await intakeMaster(json, docx, join(temporary, "runtime"), {
        comparisonPaths: [comparison],
        assertions: [
          {
            label: "Score disagreement",
            pattern: "Test score (\\d+)",
            expected: "725",
            source: "User assertion",
          },
        ],
      });
      expect(result.data.experience[0]).toMatchObject({
        company: "Test Co",
        title: "Analyst",
        start: "2020-01",
        end: "2022-05",
        bullets: ["Managed $12M", "Built reporting"],
      });
      expect(result.data.sections[0]?.entries.map((entry) => entry.heading)).toEqual([
        "Languages",
        "Interests",
      ]);
      expect(result.data.sections[1]?.title).toBe("customResearch");
      expect(
        result.manifest.leaves.find((leaf) => leaf.pointer === "/experience/0/bullets/0")
          ?.docxParagraphs,
      ).toEqual([3]);
      expect(result.manifest.conflicts.map((conflict) => conflict.kind)).toContain(
        "assertion_conflict",
      );
      expect(result.manifest.conflicts.map((conflict) => conflict.kind)).toContain(
        "source_difference",
      );
      expect(await readFile(json, "utf8")).toBe(bytes);
      expect(await readFile(docx)).toEqual(originalDocx);
      expect(result.manifest.sources[0]?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(temporary, "runtime"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
