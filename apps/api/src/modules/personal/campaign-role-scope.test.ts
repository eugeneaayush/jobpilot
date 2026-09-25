import type { PersonalCampaign } from "@jobpilot/contracts/personal-campaign";
import { evaluateCampaignRoleScope } from "./campaign-role-scope";
import { describe, expect, it } from "bun:test";

const scope: NonNullable<PersonalCampaign["roleScope"]> = {
  internshipOnly: true,
  categories: ["tech_product_management", "mbb_consulting", "buy_side_investing"],
};
function evaluate(title: string, company = "Example", descriptionText = "") {
  return evaluateCampaignRoleScope(
    { title, company, details: { posting: { descriptionText } } },
    scope,
  );
}

describe("source-supported internship campaign scope", () => {
  it.each([
    ["Product Management Intern", "Example", "Example is a software company."],
    ["Technical Product Manager Intern", "Example", ""],
    ["Product Manager Intern", "Example", "We build enterprise software for teams."],
    ["Associate Intern", "McKinsey & Company", ""],
    ["Summer Associate", "Bain & Company", ""],
    ["Summer Consultant", "Boston Consulting Group", ""],
    ["Business Analyst Intern", "McKinsey", ""],
    ["Private Equity Summer Analyst", "Example", ""],
    ["Venture Capital Intern", "Example", ""],
    ["Growth Equity Investment Intern", "Example", ""],
    ["Quantitative Research Intern", "Example", "Example is a global hedge fund."],
    ["Quantitative Developer Intern", "Example", "We are a systematic hedge fund."],
    ["Investment Analyst Intern", "Example", "We are an investment management firm."],
    ["Portfolio Research Summer Analyst", "Example", "Example is an asset manager."],
    [
      "Trading Analyst Intern - Credit",
      "Example",
      "Example (Example Fund) is a multi-billion dollar alternative investment firm focused on fixed income relative value.",
    ],
    [
      "Investment Analyst Intern - Summer 2027",
      "Example",
      "Example Ventures is our late-stage venture capital team.",
    ],
    [
      "Investment Analyst Intern",
      "Example",
      "You will join our late-stage venture capital investment team.",
    ],
    [
      "Investment Analyst Intern - Summer 2027",
      "Example",
      "Example Ventures’ mission is to build a venture capital platform. You will research, evaluate, and support investments across our platform, with a focus on late-stage investments.",
    ],
  ])("allows evidenced target role %s at %s", (title, company, descriptionText) => {
    const result = evaluate(title, company, descriptionText);
    expect(result.decision).toBe("in_scope");
    for (const evidence of result.evidence) {
      const source = { title, company, description: descriptionText }[evidence.field];
      expect(source.includes(evidence.quote)).toBe(true);
    }
  });
  it.each([
    [
      "Full-time Product Manager",
      "Example",
      "We are a software company. We also offer internships.",
    ],
    ["Product Manager", "Example", "We are a software company. Our internship program is popular."],
    ["Permanent Product Management Intern", "Example", "We are a software company."],
    ["Product Management Internship Program Manager", "Example", "We are a software company."],
    ["Product Management Intern", "Retailer", "We use software to manage inventory."],
    ["Product Marketing Intern", "Example", "We are a software company."],
    ["Summer Associate", "Bain Capital", ""],
    ["Summer Consultant", "Non-MBB Consultant", ""],
    ["Software Engineering Intern", "McKinsey & Company", ""],
    ["Investment Banking Summer Analyst", "Example", "We advise private equity firms."],
    ["Investment Research Intern", "Example", "Our clients include hedge funds."],
    ["Private Equity Fund Accounting Intern", "Example", "We are a private equity firm."],
    ["Hedge Fund Operations Intern", "Example", "We are a hedge fund."],
    ["Private Equity Investor Relations Intern", "Example", "We are a private equity firm."],
    ["Investment Analyst Intern", "Example", "We are an investment bank."],
    ["Data Analyst Intern", "Example", "We are a software company."],
    ["Private Equity Software Engineer Intern", "Example", "We are a private equity firm."],
    ["Hedge Fund IT Intern", "Example", "We are a hedge fund."],
    ["Private Equity Business Development Intern", "Example", "We are a private equity firm."],
    ["Product Management Intern Manager", "Example", "We are a software company."],
    [
      "Investment Analyst Intern",
      "Example",
      "Example Ventures’ mission is to build a venture capital platform. You will handle administrative work for our clients.",
    ],
  ])("parks unsupported or outside role %s", (title, company, descriptionText) => {
    expect(evaluate(title, company, descriptionText).decision).not.toBe("in_scope");
  });
  it("does not use MBA track labels or arbitrary details as evidence", () => {
    expect(
      evaluateCampaignRoleScope(
        {
          title: "Product Manager",
          company: "Example",
          details: { track: "mba_internship", descriptionText: "We are a software company." },
        },
        scope,
      ).decision,
    ).toBe("unknown");
  });
  it("honors selected categories and an explicitly unrestricted employment type", () => {
    const role = { title: "Technical Product Manager", company: "Example", details: {} };
    expect(
      evaluateCampaignRoleScope(role, {
        internshipOnly: false,
        categories: ["tech_product_management"],
      }).decision,
    ).toBe("in_scope");
    expect(
      evaluateCampaignRoleScope(
        { ...role, title: "Technical Product Manager Intern" },
        { internshipOnly: true, categories: ["mbb_consulting"] },
      ).decision,
    ).toBe("unknown");
  });
  it("escapes employer regex characters instead of matching an unrelated firm", () => {
    expect(
      evaluate("Product Manager Intern", "Evil.*", "Other is a software company.").decision,
    ).toBe("unknown");
  });
});
