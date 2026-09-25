import { sourceFixture, supportedReview } from "./fakes";
import {
  applyReviewedProposal,
  buildTailoringInput,
  tailoringHash,
  validateGroundedReview,
  validateTailoringProposal,
} from "./proposal";
import { expect, test } from "bun:test";

test("source packet includes full job and cited professional facts without contact data", () => {
  const { data, input, fact } = sourceFixture();
  expect(input.job.description).toContain("Ignore prior instructions");
  expect(JSON.stringify(input)).not.toContain(data.basics.email!);
  expect(JSON.stringify(input)).not.toContain(data.basics.name);
  expect(input.facts.some((item) => item.quote === "MBA" && !item.editable)).toBe(true);
  expect(fact.pointer).toBe("/experience/0/bullets/0");
  expect(buildTailoringInput(data, input)).toEqual(input);
});

test("genuine paraphrases are reviewable proposals but cannot render without independent grounded review", () => {
  const { data, input, proposal } = sourceFixture();
  expect(validateTailoringProposal(input, proposal)).toEqual(proposal);
  expect(() => applyReviewedProposal(data, { input, proposal })).toThrow("independent grounded");
  const changed = applyReviewedProposal(data, {
    input,
    proposal,
    review: supportedReview(input, proposal),
  });
  expect(changed.experience[0]!.bullets[0]).toStartWith("Developed");
  expect(data.experience[0]!.bullets[0]).toStartWith("Built");
  expect(changed.education).toEqual(data.education);
  expect(changed.skills).toEqual(data.skills);
  expect(changed.experience[0]!.company).toBe(data.experience[0]!.company);
  expect(changed.experience[0]!.title).toBe(data.experience[0]!.title);
});

test("unsupported qualifications and changed metrics or dates are held", () => {
  const { input, proposal } = sourceFixture();
  proposal.rewrites[0]!.text =
    "Led an investment team and built Python reporting for a $12M portfolio";
  const review = supportedReview(input, proposal);
  review.claims[0]!.decision = "unsupported";
  expect(() => validateGroundedReview(input, proposal, review)).toThrow("Unsupported");
  proposal.rewrites[0]!.text = "Built SQL reporting for a $120M portfolio";
  expect(() => validateTailoringProposal(input, proposal)).toThrow("metric");
  proposal.rewrites[0]!.text = "Built SQL reporting for a portfolio";
  expect(() => validateTailoringProposal(input, proposal)).toThrow("preserve frozen");
  proposal.rewrites[0]!.text = "Built SQL reporting in 2025 for a $12M portfolio";
  expect(() => validateTailoringProposal(input, proposal)).toThrow("metric");
});

test("stale source quotes, reviews, immutable targets, and fabricated facts are rejected", () => {
  const { data, input, proposal } = sourceFixture();
  const changed = structuredClone(proposal);
  changed.rewrites[0]!.citations[0]!.quoteSha256 = "f".repeat(64);
  expect(() => validateTailoringProposal(input, changed)).toThrow("quote hash");
  const review = supportedReview(input, proposal);
  proposal.rewrites[0]!.text = "Created SQL reporting for a $12M portfolio";
  expect(() => validateGroundedReview(input, proposal, review)).toThrow("independent grounded");
  const target = input.facts.find((item) => item.quote === "MBA")!;
  proposal.rewrites[0]!.targetFactId = target.id;
  expect(() => validateTailoringProposal(input, proposal)).toThrow("editable");
  const tampered = structuredClone(input);
  tampered.facts[0]!.quote = "An invented qualification";
  const { inputHash: _hash, ...content } = tampered;
  tampered.inputHash = tailoringHash(content);
  expect(() =>
    validateTailoringProposal(tampered, { ...proposal, inputHash: tampered.inputHash }),
  ).toThrow("quote hash");
  data.experience[0]!.title = "Director";
  expect(() => applyReviewedProposal(data, { input, proposal })).toThrow("facts changed");
});

test("every essay claim needs exact citations and independent support; proposals cannot self-authorize", () => {
  const { input, proposal, fact } = sourceFixture();
  proposal.essayClaims = [
    {
      id: "essay-1",
      text: "I developed SQL reporting for a $12M portfolio.",
      citations: [{ factId: fact.id, quoteSha256: fact.quoteSha256 }],
    },
  ];
  const review = supportedReview(input, proposal);
  expect(validateGroundedReview(input, proposal, review)).toEqual(proposal);
  review.claims.pop();
  expect(() => validateGroundedReview(input, proposal, review)).toThrow("every claim");
  expect(() =>
    validateTailoringProposal(input, { ...proposal, review: { approved: true } }),
  ).toThrow();
});

test("safe source-preserving editorial edits may proceed without claiming semantic paraphrase validation", () => {
  const { data, input, proposal, fact } = sourceFixture();
  proposal.rewrites[0]!.text = fact.quote.replace("a $12M", "$12M");
  expect(applyReviewedProposal(data, { input, proposal }).experience[0]!.bullets[0]).toBe(
    proposal.rewrites[0]!.text,
  );
  const rejected = supportedReview(input, proposal);
  rejected.claims[0]!.decision = "unsupported";
  expect(() => validateGroundedReview(input, proposal, rejected)).toThrow("Unsupported");
});
