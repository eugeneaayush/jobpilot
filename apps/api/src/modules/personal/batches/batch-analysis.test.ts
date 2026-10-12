import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { buildBatchAnalysis, suggestBatchMembers } from "./batch-analysis";
import { describe, expect, test } from "bun:test";

const context = {
  campaignId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  evidenceId: crypto.randomUUID(),
  sourceHash: "a".repeat(64),
  settingsHash: "b".repeat(64),
  base: { ...EMPTY_RESUME_DATA, summary: "PE VC AI" },
  keywords: ["PE", "VC", "AI", "C++", "C#"],
};
const job = (
  descriptionText: string,
  track: "mba_internship" | "general_professional" = "mba_internship",
) => ({
  id: crypto.randomUUID(),
  identity: crypto.randomUUID(),
  track,
  title: "Investment associate",
  company: "Example",
  postingContentHash: "c".repeat(64),
  posting: {
    title: "Investment associate",
    employer: "Example",
    descriptionText,
    location: "New York",
    deadline: null,
  },
});

describe("shared evidence batch analysis", () => {
  test("requires pairwise intersection / union of at least 60% while retaining short terms", () => {
    const jobs = [job("PE VC AI C++ C#"), job("PE VC AI"), job("PE VC AI C++")];
    const result = buildBatchAnalysis(context, jobs);
    expect(result.overlap.minimum).toBe(0.6);
    expect(result.sharedSupportedTerms).toEqual(["ai", "pe", "vc"]);
    expect(result.missingTerms.find((item) => item.term === "c++")?.recordIds).toHaveLength(2);
    expect(result.sourceQuestion?.match(/c\+\+/g)).toHaveLength(1);
    expect(result.sourceQuestion).toContain("does not add facts");
    expect(buildBatchAnalysis(context, jobs)).toEqual(result);
  });
  test("refuses duplicates, mixed tracks, missing descriptions and absent campaign terms", () => {
    const first = job("PE VC AI");
    expect(() => buildBatchAnalysis(context, [first, first, job("PE VC AI")])).toThrow("unique");
    expect(() =>
      buildBatchAnalysis(context, [
        first,
        job("PE VC AI"),
        job("PE VC AI", "general_professional"),
      ]),
    ).toThrow("track");
    expect(() => buildBatchAnalysis(context, [first, job(""), job("PE VC AI")])).toThrow(
      "full description",
    );
    expect(() => buildBatchAnalysis(context, [first, job("irrelevant"), job("PE VC AI")])).toThrow(
      "campaign keyword",
    );
    expect(() => buildBatchAnalysis(context, [first, job("C++ C#"), job("PE VC AI")])).toThrow(
      "60%",
    );
  });
  test("suggests bounded disjoint groups and keeps insufficient evidence separate", () => {
    const jobs = Array.from({ length: 8 }, () => job("PE VC AI"));
    const suggested = suggestBatchMembers(context, [
      ...jobs,
      job("unrelated"),
      job("PE VC AI", "general_professional"),
    ]);
    expect(suggested.map((group) => group.members.length)).toEqual([5, 3]);
    expect(
      new Set(suggested.flatMap((group) => group.members.map((item) => item.recordId))).size,
    ).toBe(8);
  });
  test("new experience stays absent until a separately accepted base revision is supplied", () => {
    const jobs = [job("PE C++"), job("PE C++"), job("PE C++")];
    const old = buildBatchAnalysis(context, jobs);
    expect(old.missingTerms.map((item) => item.term)).toEqual(["c++"]);
    const next = buildBatchAnalysis(
      {
        ...context,
        evidenceId: crypto.randomUUID(),
        base: { ...context.base, summary: "PE VC AI C++" },
      },
      jobs,
    );
    expect(next.resumeHash).not.toBe(old.resumeHash);
    expect(next.evidenceId).not.toBe(old.evidenceId);
    expect(next.missingTerms).toEqual([]);
    expect(next.sourceQuestion).toBeNull();
  });
});
