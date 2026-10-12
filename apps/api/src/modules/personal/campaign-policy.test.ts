import {
  personalCampaignCreateSchema,
  personalCampaignLaunchSchema,
} from "@jobpilot/contracts/personal-campaign";
import { preparedCampaignAnswers, recordParkReason, schedulerPolicy } from "./campaign-policy";
import { describe, expect, it } from "bun:test";

const input = {
  name: "MBA internships",
  mode: "submit" as const,
  sources: { boardTokens: ["example"] },
  tracks: ["mba_internship" as const],
  fitThreshold: 70,
  dailyCap: 1,
  maxApplications: 5,
  timezone: "America/New_York",
};
const policy = schedulerPolicy({
  personal: {
    ...input,
    scheduler: "personal-campaign-v1",
    approvalPolicy: "per-application-v1",
    enabled: true,
    policyVersion: "test",
    authorization: null,
  },
});
const record = {
  title: "Product Management Intern",
  company: "Example",
  identity: "greenhouse:example:42",
  track: "mba_internship" as const,
  state: "prepared" as const,
  details: {
    posting: {
      descriptionText:
        "This program recruits current MBA students for graduate-level responsibilities.",
    },
    fitScore: 80,
    eligibility: { decision: "eligible" },
    missingAnswers: [],
    preview: { readiness: "ready", renderReviewed: true, conflicts: [] },
    document: {},
    manifestPath: "private",
  },
};

describe("personal campaign policy", () => {
  it("requires explicit sources, bounded caps, timezone and launch authorization", () => {
    expect(personalCampaignCreateSchema.safeParse(input).success).toBe(true);
    expect(personalCampaignCreateSchema.safeParse({ ...input, dailyCap: 0 }).success).toBe(false);
    expect(
      personalCampaignCreateSchema.safeParse({ ...input, timezone: "Unknown/Zone" }).success,
    ).toBe(false);
    expect(personalCampaignLaunchSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(() => schedulerPolicy({ personal: { enabled: true } })).toThrow("not a configured");
  });
  it("parks failed scope and readiness while using fit only for ranking", () => {
    expect(recordParkReason(record, policy)).toBeNull();
    expect(recordParkReason({ ...record, identity: "greenhouse:example2:42" }, policy)).toContain(
      "Source",
    );
    expect(recordParkReason({ ...record, track: "post_mba_fulltime" }, policy)).toContain("Track");
    expect(
      recordParkReason({ ...record, details: { ...record.details, fitScore: 20 } }, policy),
    ).toBeNull();
    expect(
      recordParkReason(
        { ...record, details: { ...record.details, missingAnswers: ["Sponsorship"] } },
        policy,
      ),
    ).toContain("answers");
    expect(
      recordParkReason(
        {
          ...record,
          details: {
            ...record.details,
            preview: { ...record.details.preview, readiness: "draft" },
          },
        },
        policy,
      ),
    ).toContain("draft");
    expect(
      recordParkReason(
        { ...record, details: { ...record.details, eligibility: { decision: "unknown" } } },
        { ...policy, mode: "offline" },
      ),
    ).toBeNull();
  });
  it("keeps exact prepared answer values and never invents answers", () => {
    expect(preparedCampaignAnswers({})).toEqual([]);
    expect(
      preparedCampaignAnswers([
        { key: "work", value: "User's exact answer", fieldName: "authorization" },
      ]),
    ).toEqual([{ key: "work", value: "User's exact answer", fieldName: "authorization" }]);
    expect(() => preparedCampaignAnswers({ sponsorship: "unknown" })).toThrow("explicit array");
    expect(() =>
      preparedCampaignAnswers([
        { key: "x", value: "a" },
        { key: "x", value: "b" },
      ]),
    ).toThrow("unique");
  });
  it("parks ambiguous or out-of-scope roles even for offline campaigns", () => {
    const scoped = {
      ...policy,
      mode: "offline" as const,
      roleScope: {
        internshipOnly: true,
        categories: ["tech_product_management" as const],
      },
    };
    expect(recordParkReason(record, scoped)).toContain("Campaign role scope");
    expect(
      recordParkReason(
        {
          ...record,
          details: {
            ...record.details,
            posting: {
              descriptionText: `${record.details.posting.descriptionText} Example is a software company.`,
            },
          },
        },
        scoped,
      ),
    ).toBeNull();
    expect(recordParkReason({ ...record, title: "Full-time Product Manager" }, scoped)).toContain(
      "not an internship",
    );
    expect(
      personalCampaignCreateSchema.safeParse({
        ...input,
        roleScope: { internshipOnly: true, categories: [] },
      }).success,
    ).toBe(false);
  });
});
