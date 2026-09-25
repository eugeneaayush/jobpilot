import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import type { PersonalRecord, PersonalResumeEvidence, Prisma } from "@/generated/prisma/client";
import { verifyRecruitingConstraints } from "./graduate-eligibility-policy";
import { manifestHash, policyDay, trustedRequisition } from "./persistence-policy";
import { recoveryContext, recoveryRequirements } from "./recovery-policy";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { employerIdentity, enforceEmployerCap } from "./user-policy";
import { describe, expect, it } from "bun:test";

const settings = personalSettingsSchema.parse({
  recruitingAvailability: {
    partTimeNow: true,
    partTimeMaxHours: 20,
    partTimeLocations: ["NYC", "US remote"],
    internshipStartMonth: "2027-05",
    internshipEndMonth: "2027-09",
    permanentStartMonth: "2028-05",
    paidOnly: true,
    englishSufficientOnly: true,
    employerSupportedInternational: true,
    unrestrictedTravelRelocation: true,
  },
  workAuthorization: true,
  workAuthorizationCountries: ["US"],
  citizenship: "US",
});
const description =
  "This paid internship recruits MBA students. The internship runs from June 2027 to August 2027. You will work with our team and conduct research for our clients.";
const evidence = {
  id: crypto.randomUUID(),
  sourceHash: "a".repeat(64),
  details: { conflicts: [] },
} as unknown as PersonalResumeEvidence;
function fixture(descriptionText = description, location = "New York, NY") {
  return {
    id: crypto.randomUUID(),
    identity: "greenhouse:synthetic:1",
    title: "MBA internship",
    company: "Synthetic",
    updatedAt: new Date("2026-09-16T12:00:00Z"),
    details: { posting: { descriptionText, location }, eligibility: { decision: "eligible" } },
  } as unknown as PersonalRecord;
}
function adjudicate(record: PersonalRecord, pointer: string, value: string | boolean) {
  const posting = (record.details as { posting: { descriptionText: string; location: string } })
    .posting;
  const requirements = assessRecruitingConstraints(
    { title: record.title, ...posting },
    settings,
  ).requirements;
  record.details = { ...(record.details as object), evaluation: { requirements } };
  const unknown = recoveryRequirements(record.details).find((r) => r.status === "unknown")!;
  record.details = {
    ...(record.details as object),
    eligibilityAdjudication: {
      context: recoveryContext(record, settings, evidence),
      decisions: [
        {
          requirementId: unknown.id,
          status: "satisfied",
          rationale: "Owner reviewed this exact source requirement",
          sourceQuote: unknown.evidence,
          citation: { kind: "settings", pointer, value },
        },
      ],
    },
  };
  return record;
}

describe("graduate submission eligibility", () => {
  it("requires explicit approved availability despite a saved eligible flag", () => {
    expect(() =>
      verifyRecruitingConstraints(fixture(), personalSettingsSchema.parse({}), evidence),
    ).toThrow("Approved recruiting availability");
  });
  it("accepts explicit matching dates, pay, location, and English posting evidence", () => {
    expect(() => verifyRecruitingConstraints(fixture(), settings, evidence)).not.toThrow();
  });
  it("holds a current unknown instead of trusting saved eligibility", () => {
    const record = fixture(description.replace("June 2027 to August 2027", "Summer 2027"));
    expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
      "current source review",
    );
  });
  it("cannot adjudicate an explicitly violated availability window", () => {
    const record = fixture(description.replace("August 2027", "October 2027"));
    expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
      "constraint violated",
    );
  });
  it("rejects an exact but unrelated citizenship citation for availability", () => {
    const record = adjudicate(
      fixture(description.replace("June 2027 to August 2027", "Summer 2027")),
      "/citizenship",
      "US",
    );
    expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
      "relevant source evidence",
    );
  });
  it("an internship cannot cite permanent or part-time availability instead", () => {
    for (const [pointer, value] of [
      ["/recruitingAvailability/permanentStartMonth", "2028-05"],
      ["/recruitingAvailability/partTimeNow", true],
    ] as const) {
      const record = adjudicate(
        fixture(description.replace("June 2027 to August 2027", "Summer 2027")),
        pointer,
        value,
      );
      expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
        "relevant source evidence",
      );
    }
  });
  it("a candidate preference cannot override an employer's required foreign language", () => {
    const record = adjudicate(
      fixture(`${description} Mandarin fluency is required.`),
      "/recruitingAvailability/englishSufficientOnly",
      true,
    );
    expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
      "relevant source evidence",
    );
  });
  it("a paid-only preference cannot prove unconfirmed employer compensation", () => {
    const record = adjudicate(
      fixture(description.replace("paid internship", "internship")),
      "/recruitingAvailability/paidOnly",
      true,
    );
    expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
      "relevant source evidence",
    );
  });
  it("citizenship alone cannot establish an employer-supported international route", () => {
    const record = adjudicate(fixture(description, "London, United Kingdom"), "/citizenship", "US");
    expect(() => verifyRecruitingConstraints(record, settings, evidence)).toThrow(
      "relevant source evidence",
    );
  });
  it("rejects stale adjudication when settings change", () => {
    const record = adjudicate(
      fixture(description.replace("June 2027 to August 2027", "Summer 2027")),
      "/recruitingAvailability/internshipStartMonth",
      "2027-05",
    );
    expect(() =>
      verifyRecruitingConstraints(record, { ...settings, citizenship: "CA" }, evidence),
    ).toThrow("current source review");
  });
});

describe("graduate identity and cap invariants", () => {
  it("uses an exact canonical employer plus requisition across ATS labels", () => {
    function record(source: "greenhouse" | "ashby", employer: string) {
      const posting = {
        source,
        boardToken: "synthetic",
        nativeId: source,
        requisitionId: "MBA-27",
        employer,
        url: `https://example.test/${source}`,
      };
      return {
        identity: `${source}:synthetic:${source}`,
        requisitionId: source,
        company: employer,
        url: posting.url,
        details: { posting },
      };
    }
    const a = record("greenhouse", "Synthetic Capital");
    const b = record("ashby", "Synthetic Capital LLC");
    expect(trustedRequisition(a).employerRequisitionKey).not.toBe(
      trustedRequisition(b).employerRequisitionKey,
    );
    expect(trustedRequisition(a, "domain:synthetic.test").employerRequisitionKey).toBe(
      trustedRequisition(b, "domain:synthetic.test").employerRequisitionKey,
    );
    expect(trustedRequisition(a, "domain:synthetic.test").employerRequisitionKey).not.toBe(
      trustedRequisition(b, "domain:another.test").employerRequisitionKey,
    );
    expect(trustedRequisition(a).employerRequisitionKey).toBe(
      trustedRequisition(a, "name:synthetic capital").employerRequisitionKey,
    );
  });
  it("ignores a legacy CBS board alias spanning different firms", async () => {
    let lookups = 0;
    const tx = {
      personalEmployerAlias: {
        findUnique: async () => {
          lookups++;
          return { canonicalEmployer: "domain:wrong.test" };
        },
      },
    } as unknown as Prisma.TransactionClient;
    const result = await employerIdentity(tx, "synthetic-user", {
      company: "Fund One",
      details: { posting: { source: "cbs", boardToken: "whole-class" } },
    });
    expect(result).toBe("name:fund one");
    expect(lookups).toBe(0);
  });
  it("counts submitted and uncertain employer applications and excludes only the current attempt", async () => {
    let query: unknown;
    const record = {
      company: "Synthetic",
      details: { posting: { source: "cbs", boardToken: "class" } },
    };
    const tx = {
      personalAttempt: {
        findMany: async (input: unknown) => {
          query = input;
          return [{ record }, { record }, { record }];
        },
      },
    } as unknown as Prisma.TransactionClient;
    await expect(
      enforceEmployerCap(tx, "synthetic-user", "name:synthetic", 3, "current-attempt"),
    ).rejects.toThrow("active-application limit");
    expect(query).toMatchObject({
      where: {
        userId: "synthetic-user",
        mode: "submit",
        id: { not: "current-attempt" },
        state: { in: ["preparing", "prepared", "submitting", "submitted", "submission_uncertain"] },
      },
    });
  });
  it("uses New York day boundaries during both standard and daylight time", () => {
    expect(policyDay("America/New_York", new Date("2026-01-01T04:59:59Z"))).toBe("2025-12-31");
    expect(policyDay("America/New_York", new Date("2026-01-01T05:00:00Z"))).toBe("2026-01-01");
    expect(policyDay("America/New_York", new Date("2026-07-01T03:59:59Z"))).toBe("2026-06-30");
    expect(policyDay("America/New_York", new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
    expect(manifestHash({ dailyCap: 50, timezone: "America/New_York" })).not.toBe(
      manifestHash({ dailyCap: 49, timezone: "America/New_York" }),
    );
  });
});
