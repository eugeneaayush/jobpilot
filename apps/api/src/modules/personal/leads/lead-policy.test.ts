import {
  normalizeLeadUrl,
  officialLeadDestination,
  requireFullDiscoveryDescriptions,
  sourceEnabled,
} from "./lead-policy";
import { describe, expect, test } from "bun:test";

describe("lead destinations", () => {
  test("removes only known tracking and retains requisition parameters", () => {
    expect(
      normalizeLeadUrl(
        "https://careers.example.com/opening?gh_jid=12&jobId=33&utm_source=x&ref=identity#apply",
      ),
    ).toBe("https://careers.example.com/opening?gh_jid=12&jobId=33&ref=identity");
  });
  test("recognizes exact supported hosts and stable ATS identities", () => {
    expect(
      officialLeadDestination("https://job-boards.greenhouse.io/company/jobs/42?utm_source=x"),
    ).toMatchObject({ source: "greenhouse", boardToken: "company", nativeId: "42" });
    expect(officialLeadDestination("https://jobs.eu.lever.co/company/abc/apply")).toMatchObject({
      source: "lever",
      region: "eu",
      nativeId: "abc",
    });
    expect(
      officialLeadDestination("https://jobs.ashbyhq.com/company/abc/application?embed=true"),
    ).toMatchObject({ source: "ashby", nativeId: "abc" });
  });
  test("never accepts redirects, local targets, lookalikes or unknown URLs as official sources", () => {
    for (const url of [
      "http://localhost/a",
      "https://127.0.0.1/a",
      "https://[::1]/a",
      "https://jobs.lever.co.attacker.com/company/abc",
      "https://jobs.lever.co:444/company/abc",
      "https://user@jobs.lever.co/company/abc",
      "https://redirect.example/?url=https://jobs.lever.co/company/abc",
      "https://jobs.lever.co/company/abc/other",
    ])
      expect(() => officialLeadDestination(url)).toThrow();
  });
  test("optional sources default off and malformed configuration cannot enable", () => {
    expect(sourceEnabled(undefined, "boards", "linkedin")).toBe(false);
    expect(sourceEnabled({ boards: true }, "boards", "linkedin")).toBe(false);
    expect(sourceEnabled({ boards: ["linkedin"], feeds: [] }, "boards", "linkedin")).toBe(true);
    expect(sourceEnabled({ boards: ["linkedin"] }, "boards", "indeed")).toBe(false);
  });
});

test("full descriptions are required before any official discovery promotion", () => {
  const result = requireFullDiscoveryDescriptions({
    status: "complete" as const,
    postings: [{ descriptionText: " " }, { descriptionText: "Must be enrolled in an MBA." }],
    health: { errors: [] as string[] },
  });
  expect(result.status).toBe("partial");
  expect(result.postings).toHaveLength(1);
  expect(result.health.errors[0]).toContain("full description");
});
