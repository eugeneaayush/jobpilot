import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { describe, expect, test } from "bun:test";

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
});
const preamble =
  "The expected hourly rate for this full-time position is listed below. Interns are also eligible to participate in the Company’s generous benefits programs, subject to eligibility requirements.";
function assess(descriptionText: string) {
  return assessRecruitingConstraints(
    { title: "Summer 2027 MBA Intern", descriptionText, location: "New York, NY" },
    settings,
  );
}
function pay(descriptionText: string) {
  return assess(descriptionText).requirements.find(
    (item) => item.requirement === "Paid compensation",
  )!;
}

describe("adjacent labeled wage amounts", () => {
  test("recognizes the public hourly MBA pay block and retains its exact source", () => {
    const block = "Hourly MBA Pay\n$50 &mdash; $50 USD";
    const source = `${preamble}\n\n${block}`;
    expect(pay(source).status).toBe("satisfied");
    expect(pay(source).evidence).toBe(block);
    expect(source).toContain(pay(source).evidence);
    expect(
      assess(source).requirements.find((item) => item.requirement === "Recruiting availability")
        ?.status,
    ).toBe("satisfied");
  });

  test("recognizes strict hourly, monthly, and annual labels", () => {
    for (const block of [
      "Hourly Pay\n$50 USD",
      "Monthly MBA Pay:\n$8,000 - $9,000 USD",
      "Annual Base Salary\n£100,000 – £120,000 GBP",
      "Yearly Compensation\nEUR 80,000",
      "Hourly Wage Range\n€25.50 — €30 EUR",
      "Monthly Salary\r\n\r\n$8,000 USD",
      "Hourly MBA Pay\n   \n$50 USD",
    ]) {
      expect(pay(block).status).toBe("satisfied");
      expect(pay(block).evidence).toBe(block);
    }
  });

  test("decodes only known dash entities for matching without rewriting evidence", () => {
    for (const dash of ["&mdash;", "&ndash;", "&#8212;", "&#8211;", "&#x2014;", "&#x2013;"]) {
      const block = `Hourly MBA Pay\n$50 ${dash} $60 USD`;
      expect(pay(block).status).toBe("satisfied");
      expect(pay(block).evidence).toBe(block);
    }
    for (const amount of [
      "$50 &unknown; $60 USD",
      "$50 &lt;script&gt; $60 USD",
      "$50 &amp;mdash; $60 USD",
    ])
      expect(pay(`Hourly MBA Pay\n${amount}`).status).toBe("unknown");
  });

  test("requires the amount to be adjacent rather than borrowing later customer prices", () => {
    for (const source of [
      "Hourly MBA Pay\nTo be discussed\n$50 USD",
      "Hourly MBA Pay\nCustomer subscription price\n$50 USD",
      "Hourly MBA Pay\nExpense reimbursement\n$50 USD",
      "Hourly MBA Pay\nBenefits\n$50 USD",
    ])
      expect(pay(source).status).toBe("unknown");
  });

  test("benefits, paid leave, expenses, and customer prices cannot act as wage labels", () => {
    for (const block of [
      "Monthly Benefits\n$500 USD",
      "Hourly Paid Time Off\n$50 USD",
      "Monthly PTO Pay\n$500 USD",
      "Monthly Expense Reimbursement\n$500 USD",
      "Hourly Customer Price\n$50 USD",
      "Hourly Customer Pay\n$50 USD",
      "Hourly MBA Pay Reimbursement\n$50 USD",
      "Customer Pricing\nHourly Pay\n$50 USD",
      "Expense Reimbursement\nHourly Pay\n$50 USD",
      "Benefits\nHourly Pay\n$50 USD",
      "Customers pay $50 USD for the subscription.",
      "We reimburse expenses with monthly pay of $500 USD.",
    ])
      expect(pay(`${preamble}\n${block}`).status).toBe("unknown");
  });

  test("the existing range preamble cannot borrow benefits, expense, or customer amounts", () => {
    for (const heading of ["Benefits", "Expense Reimbursement", "Customer Pricing"])
      expect(
        pay(`The salary range for this role is listed below.\n${heading}\n$50 USD`).status,
      ).toBe("unknown");
  });

  test("an explicitly paid role remains paid when its duties mention clients or expenses", () => {
    for (const source of [
      "This is a paid internship working with clients.",
      "This is a paid role with expense reimbursement and paid time off.",
    ])
      expect(pay(source).status).toBe("satisfied");
  });

  test("negated, zero, and unpaid statements cannot become affirmative pay", () => {
    for (const block of [
      "No Hourly MBA Pay\n$50 USD",
      "Hourly MBA Pay\n$0 USD",
      "Hourly MBA Pay\n$0 &mdash; $50 USD",
      "Hourly MBA Pay\n$50 &mdash; $0 USD",
      "This is an unpaid internship.\nHourly MBA Pay\n$50 USD",
      "This internship has no salary.\nHourly MBA Pay\n$50 USD",
      "Unpaid\nHourly MBA Pay\n$50 USD",
      "This internship is not compensated.\nHourly MBA Pay\n$50 USD",
    ])
      expect(pay(block).status).not.toBe("satisfied");
  });

  test("holds malformed or mismatched currency ranges and non-wage suffixes", () => {
    for (const amount of [
      "$60 - $50 USD",
      "$50 - €60 USD",
      "$50 EUR",
      "$50 USD per customer",
      "$50 USD expense reimbursement",
      "$50 USD paid time off",
      "$5,0 USD",
      "50",
      "$50 USD (not compensation)",
    ])
      expect(pay(`Hourly MBA Pay\n${amount}`).status).toBe("unknown");
  });

  test("explicit uncompensated employment overrides a distant positive wage block", () => {
    for (const statement of [
      "This internship is not compensated.",
      "The summer internship will be uncompensated.",
      "Our role is without remuneration.",
      "The internship has no remuneration.",
      "This role offers no remuneration.",
      "Our program provides no remuneration.",
      "Interns will be not compensated.",
      "No remuneration will be provided for this internship.",
    ]) {
      const source = `${statement}\nWe provide mentorship and training.\nHourly MBA Pay\n$50 USD`;
      expect(pay(source).status).toBe("violated");
      expect(pay(source).evidence).toBe(statement);
    }
  });

  test("uncompensated expenses and past roles do not negate this role's pay", () => {
    for (const statement of [
      "Travel expenses are not compensated.",
      "The previous internship was not compensated.",
      "Volunteers in a separate program are uncompensated.",
    ])
      expect(
        pay(`${statement}\nWe provide mentorship and training.\nHourly MBA Pay\n$50 USD`).status,
      ).toBe("satisfied");
  });
});
