import { officialLeadDestination } from "./lead-policy";
import { resolvedLeadRecord } from "./lead-resolution";
import { describe, expect, test } from "bun:test";

const destination = officialLeadDestination("https://jobs.lever.co/example/42");
const row = {
  id: crypto.randomUUID(),
  identity: destination.identity,
  details: {
    sourceRunId: "fresh",
    posting: {
      nativeId: "42",
      descriptionText: "Full employer requirements.",
      contentHash: "a".repeat(64),
      url: "https://jobs.lever.co/example/42",
    },
  },
};
describe("lead promotion evidence", () => {
  test("requires an exact fresh requisition and never accepts an old duplicate as a refresh", () => {
    expect(resolvedLeadRecord(row, destination, "fresh")).toBe(row.id);
    expect(() => resolvedLeadRecord(null, destination, "fresh")).toThrow("did not return");
    expect(() => resolvedLeadRecord(row, destination, "another-run")).toThrow("fresh");
    expect(() =>
      resolvedLeadRecord({ ...row, identity: "lever:global:example:99" }, destination, "fresh"),
    ).toThrow("requisition");
    expect(() =>
      resolvedLeadRecord(
        {
          ...row,
          details: {
            ...row.details,
            posting: { ...row.details.posting, url: "https://jobs.lever.co/different/42" },
          },
        },
        destination,
        "fresh",
      ),
    ).toThrow("identity differs");
    expect(() =>
      resolvedLeadRecord(
        {
          ...row,
          details: { ...row.details, posting: { ...row.details.posting, descriptionText: " " } },
        },
        destination,
        "fresh",
      ),
    ).toThrow("full-description");
  });
});
