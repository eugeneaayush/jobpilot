import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { generateDraftPdf } from "./document";
import { describe, expect, test } from "bun:test";

describe("fact-preserving CBS draft PDF", () => {
  test("reorders without loss, freezes by digest, never becomes ready", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "document-test-"));
    try {
      const base = {
        ...EMPTY_RESUME_DATA,
        basics: { name: "Synthetic Candidate", email: "test@example.com" },
        education: [{ school: "Test School", degree: "MBA", details: ["Test honors"] }],
        experience: [
          {
            company: "Example Co",
            title: "Analyst",
            start: "2020",
            end: "2022",
            bullets: [
              "Supported operations",
              "Built SQL reporting for $12M portfolio",
              "One",
              "Two",
              "Three",
              "Four",
              "Five",
              "Six",
            ],
          },
        ],
        sections: [
          {
            title: "Additional Information",
            entries: [{ heading: "Languages", bullets: ["English"] }],
          },
        ],
      };
      const before = JSON.stringify(base);
      const result = await generateDraftPdf(base, temporary, {
        jobKeywords: ["SQL"],
        conflicts: ["Needs source review"],
      });
      expect(JSON.stringify(base)).toBe(before);
      expect(result.data.experience[0]?.bullets).toHaveLength(8);
      expect(result.data.experience[0]?.bullets[0]).toContain("SQL");
      expect(result.data.experience[0]?.company).toBe("Example Co");
      expect(result.status).toBe("draft");
      expect(result.renderQa).toBe("required");
      const bytes = await readFile(result.path);
      expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.sha256);
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
      const info = Bun.spawn(["pdfinfo", result.path], { stdout: "pipe" });
      const infoText = await new Response(info.stdout).text();
      expect(await info.exited).toBe(0);
      expect(infoText).toMatch(/612 x 792 pts/);
      const text = Bun.spawn(["pdftotext", result.path, "-"], { stdout: "pipe" });
      const extracted = await new Response(text.stdout).text();
      expect(await text.exited).toBe(0);
      expect(extracted).toContain("$12M");
      expect(extracted.indexOf("EDUCATION")).toBeLessThan(extracted.indexOf("EXPERIENCE"));
      expect(extracted).toContain("Languages");
      expect(extracted).toContain("DRAFT");
      expect(extracted).toContain("unresolved source facts; not ready for submission");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
