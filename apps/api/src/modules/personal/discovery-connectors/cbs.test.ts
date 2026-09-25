import { normalizeCbsImport } from "./cbs";
import { sha256 } from "./common";
import { now } from "./fakes";
import { describe, expect, test } from "bun:test";

const sourceUrl = "https://cbs.example.edu/jobs/export";
const row = {
  id: "cbs-1",
  title: "MBA Intern",
  employer: "Example Capital",
  url: "https://employer.example/jobs/1",
  description: "Full role description.",
};
const json = (rows: unknown) =>
  normalizeCbsImport(JSON.stringify(rows), { format: "json", sourceUrl, now });

describe("CBS supplied export normalization", () => {
  test("CSV preserves quoted multiline descriptions, exact source hash and physical row lines", () => {
    const input =
      '\uFEFFJob ID,Job Title,Company,Job URL,Description,Employer ID,Requisition ID,Date Posted\r\n1,MBA Intern,Example Capital,https://employer.example/jobs/1,"Investments, research\r\nUse ""quoted"" evidence.",firm-1,req-1,2026-09-15\r\n2,PM Intern,Example Tech,https://employer.example/jobs/2,Full description,firm-2,req-2,2026-09-16\r\n';
    const result = normalizeCbsImport(input, {
      format: "csv",
      sourceUrl,
      boardToken: "cbs-2026",
      now,
    });
    expect(result.status).toBe("complete");
    expect(result.contentHash).toBe(sha256(input));
    expect(result.expectedTotal).toBe(2);
    expect(result.health.attempts).toBe(0);
    expect(result.health.httpStatus).toBeNull();
    expect(result.coverage.scope).toBe("provided_export");
    expect(result.postings[0]).toMatchObject({
      boardToken: "cbs-2026",
      employerId: "firm-1",
      requisitionId: "req-1",
      publishedAt: "2026-09-15",
      publishedAtMeaning: "export_reported",
      firstPublishedAt: null,
      descriptionText: 'Investments, research\r\nUse "quoted" evidence.',
      provenance: { row: 1, line: 2, responseHash: sha256(input) },
    });
    expect(result.postings[1]?.provenance.line).toBe(4);
  });
  test("JSON accepts explicit aliases without fuzzy employer joins or inferred dates", () => {
    const result = json({
      jobs: [
        {
          "Job ID": 17,
          "Job Title": "PM Intern",
          Company: "Unverified Export Name",
          "Application URL": "https://employer.example/jobs/17",
          "Description HTML": "<p>Full description.</p>",
          "Application Deadline": "2026-12-01",
        },
      ],
    });
    expect(result.status).toBe("complete");
    expect(result.postings[0]).toMatchObject({
      nativeId: "17",
      employer: "Unverified Export Name",
      employerNameSource: "export",
      employerId: null,
      publishedAt: null,
      deadline: "2026-12-01",
      provenance: { line: null, row: 1 },
    });
  });
  test("complete empty supplied export is separate from malformed and missing-column exports", () => {
    expect(json([]).coverage.empty).toBe(true);
    const emptyCsv = normalizeCbsImport("id,title,employer,url,description\n", {
      format: "csv",
      sourceUrl,
    });
    expect(emptyCsv.status).toBe("complete");
    expect(emptyCsv.coverage.empty).toBe(true);
    for (const input of [
      "",
      "title,employer\n",
      'id,title,employer,url,description\n1,hi,there,url,"unclosed',
    ]) {
      const result = normalizeCbsImport(input, { format: "csv", sourceUrl });
      expect(result.status).toBe("failed");
      expect(result.coverage.empty).toBeNull();
    }
    expect(json({ rows: [] }).status).toBe("failed");
  });
  test("row failures preserve valid rows and never silently report full coverage", () => {
    const result = json([
      row,
      row,
      { ...row, id: "no-description", description: "" },
      { ...row, id: "bad-url", url: "javascript:alert(1)" },
      { ...row, id: "date", publishedAt: "09/16/2026" },
      { ...row, id: "impossible", deadline: "2026-02-30" },
    ]);
    expect(result.status).toBe("partial");
    expect(result.postings).toHaveLength(1);
    expect(result.expectedTotal).toBe(6);
    expect(result.health.errors).toHaveLength(5);
    expect(result.coverage.empty).toBeNull();
  });
  test("rejects duplicate header aliases, extra cells and malformed quote placement", () => {
    const duplicate = normalizeCbsImport("id,title,Job Title,employer,url,description\n", {
      format: "csv",
      sourceUrl,
    });
    expect(duplicate.status).toBe("failed");
    const extra = normalizeCbsImport(
      "id,title,employer,url,description\n1,Intern,Example,https://example.com/jobs/1,desc,extra",
      { format: "csv", sourceUrl },
    );
    expect(extra.status).toBe("partial");
    expect(extra.postings).toHaveLength(0);
    const quote = normalizeCbsImport(
      'id,title,employer,url,description\n1,In"tern,Example,url,desc',
      { format: "csv", sourceUrl },
    );
    expect(quote.status).toBe("failed");
    expect(json([{ ...row, "Job Title": "Conflicting title" }]).status).toBe("partial");
  });
  test("bounds input bytes and rows, and rejects unsafe provenance without fetching", () => {
    expect(normalizeCbsImport(" ".repeat(5_000_001), { format: "json", sourceUrl }).status).toBe(
      "failed",
    );
    expect(json(Array.from({ length: 5001 }, () => row)).status).toBe("failed");
    expect(() =>
      normalizeCbsImport("[]", { format: "json", sourceUrl: "file:///private/export.json" }),
    ).toThrow("Untrusted");
    expect(() =>
      normalizeCbsImport("[]", { format: "json", sourceUrl, boardToken: "../other" }),
    ).toThrow("board token");
  });
});
