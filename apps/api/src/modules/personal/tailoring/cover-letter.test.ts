import { coverLetterContent } from "../document/cover-letter";
import { sourceFixture, supportedReview } from "./fakes";
import { expect, test } from "bun:test";

test("cover-letter prose uses only independently reviewed claims and preserves original citations", () => {
  const { data, input, proposal, fact } = sourceFixture();
  proposal.essayClaims = [
    {
      id: "essay-1",
      text: "I developed SQL reporting for a $12M portfolio.",
      citations: [{ factId: fact.id, quoteSha256: fact.quoteSha256 }],
    },
  ];
  const reviewed = { input, proposal, review: supportedReview(input, proposal) };
  const content = coverLetterContent(data, input.job, reviewed);
  expect(content.paragraphs).toContain(proposal.essayClaims[0]!.text);
  expect(content.citations).toContainEqual({ pointer: fact.pointer, value: fact.quote });
  reviewed.review.claims.find((item) => item.claimId === "essay-1")!.decision = "unsupported";
  expect(() => coverLetterContent(data, input.job, reviewed)).toThrow("Unsupported");
});

test("requested reviewed cover letter cannot fall back silently when no essay was prepared", () => {
  const { data, input, proposal } = sourceFixture();
  expect(() =>
    coverLetterContent(data, input.job, {
      input,
      proposal,
      review: supportedReview(input, proposal),
    }),
  ).toThrow("claims are missing");
});
