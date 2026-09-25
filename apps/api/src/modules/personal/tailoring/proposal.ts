import { createHash } from "node:crypto";
import { type ResumeData, resumeDataSchema } from "@jobpilot/contracts/resume";
import { z } from "zod/v4";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const citationSchema = z.object({ factId: hash, quoteSha256: hash }).strict();
const claimSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    text: z.string().min(1).max(6000),
    citations: z.array(citationSchema).min(1).max(20),
  })
  .strict();
export const tailoringProposalSchema = z
  .object({
    version: z.literal(1),
    inputHash: hash,
    rewrites: z.array(claimSchema.extend({ targetFactId: hash })).max(200),
    essayClaims: z.array(claimSchema).max(100),
  })
  .strict();
export type TailoringProposal = z.infer<typeof tailoringProposalSchema>;
export interface TailoringInput {
  version: 1;
  sourceDigest: string;
  baseDataHash: string;
  inputHash: string;
  maxPages: 1 | 2;
  job: {
    identity: string;
    title: string;
    company: string;
    description: string;
    postingContentHash: string;
  };
  facts: { id: string; pointer: string; quote: string; quoteSha256: string; editable: boolean }[];
}
const groundedReviewSchema = z
  .object({
    sourceDigest: hash,
    inputHash: hash,
    proposalHash: hash,
    reviewer: z.string().min(1).max(200),
    reviewedAt: z.iso.datetime(),
    independent: z.literal(true),
    claims: z
      .array(
        z
          .object({
            claimId: z.string().min(1).max(80),
            decision: z.enum(["supported", "unsupported", "unknown"]),
            factIds: z.array(hash).min(1).max(20),
            rationale: z.string().min(1).max(6000),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
export type GroundedReview = z.infer<typeof groundedReviewSchema>;
export interface ReviewedProposal {
  input: TailoringInput;
  proposal: TailoringProposal;
  review?: GroundedReview;
}
export function tailoringHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function buildTailoringInput(
  data: ResumeData,
  options: {
    sourceDigest: string;
    job: TailoringInput["job"];
    maxPages: 1 | 2;
  },
): TailoringInput {
  hash.parse(options.sourceDigest);
  if (options.maxPages !== 1 && options.maxPages !== 2)
    throw new Error("Invalid resume page bound");
  hash.parse(options.job.postingContentHash);
  if (!options.job.description.trim() || options.job.description.length > 200_000)
    throw new Error("Full bounded job description is required");
  const facts: TailoringInput["facts"] = [];
  const walk = (value: unknown, pointer: string) => {
    if (typeof value === "string" && value.trim()) {
      const quoteSha256 = tailoringHash(value);
      facts.push({
        id: tailoringHash({ sourceDigest: options.sourceDigest, pointer, quoteSha256 }),
        pointer,
        quote: value,
        quoteSha256,
        editable: /^\/(experience|projects)\/\d+\/bullets\/\d+$/.test(pointer),
      });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value))
        if (key !== "id")
          walk(child, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  };
  const parsed = resumeDataSchema.parse(data);
  for (const [key, value] of Object.entries(parsed)) if (key !== "basics") walk(value, `/${key}`);
  const content = {
    version: 1 as const,
    sourceDigest: options.sourceDigest,
    baseDataHash: tailoringHash(parsed),
    maxPages: options.maxPages,
    job: structuredClone(options.job),
    facts,
  };
  if (JSON.stringify(content).length > 500_000)
    throw new Error("Tailoring facts exceed the input bound");
  return { ...content, inputHash: tailoringHash(content) };
}
function checkInput(input: TailoringInput): void {
  const { inputHash, ...content } = input;
  if (tailoringHash(content) !== inputHash) throw new Error("Tailoring input hash mismatch");
  for (const fact of input.facts) {
    if (
      tailoringHash(fact.quote) !== fact.quoteSha256 ||
      fact.id !==
        tailoringHash({
          sourceDigest: input.sourceDigest,
          pointer: fact.pointer,
          quoteSha256: fact.quoteSha256,
        })
    )
      throw new Error("Source quote hash mismatch");
  }
}
const metrics = (text: string) =>
  text.match(
    /(?:[$€£¥]|[+-])?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|[KMB]\b|million\b|billion\b|thousand\b))?/g,
  ) ?? [];
const contentWords = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}$€£¥%+-]+/gu)
    ?.filter((word) => !["a", "an", "the"].includes(word)) ?? [];
export function validateTailoringProposal(
  input: TailoringInput,
  value: unknown,
): TailoringProposal {
  checkInput(input);
  const proposal = tailoringProposalSchema.parse(value);
  if (proposal.inputHash !== input.inputHash) throw new Error("Proposal belongs to another input");
  const facts = new Map(input.facts.map((fact) => [fact.id, fact]));
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const claim of [...proposal.rewrites, ...proposal.essayClaims]) {
    if (ids.has(claim.id)) throw new Error("Duplicate proposal claim");
    ids.add(claim.id);
    const cited = claim.citations.map((citation) => {
      const fact = facts.get(citation.factId);
      if (!fact || fact.quoteSha256 !== citation.quoteSha256)
        throw new Error("Claim source quote hash mismatch");
      return fact;
    });
    const allowedMetrics = new Set(cited.flatMap((fact) => metrics(fact.quote)));
    if (metrics(claim.text).some((metric) => !allowedMetrics.has(metric)))
      throw new Error("Claim changes a frozen metric or date");
    if ("targetFactId" in claim) {
      const target = facts.get(String(claim.targetFactId));
      if (
        !target?.editable ||
        !cited.some((fact) => fact.id === target.id) ||
        targets.has(target.id)
      )
        throw new Error("Rewrite must cite one unique editable source bullet");
      targets.add(target.id);
      if (JSON.stringify(metrics(claim.text)) !== JSON.stringify(metrics(target.quote)))
        throw new Error("Rewrite must preserve frozen metrics and dates exactly");
    }
  }
  return proposal;
}
function extractive(
  input: TailoringInput,
  claim: TailoringProposal["essayClaims"][number],
): boolean {
  const targetId = "targetFactId" in claim ? claim.targetFactId : undefined;
  const cited = claim.citations.map(
    (citation) => input.facts.find((fact) => fact.id === citation.factId)!,
  );
  return cited.some(
    (fact) =>
      (!targetId || fact.id === targetId) &&
      JSON.stringify(contentWords(claim.text)) === JSON.stringify(contentWords(fact.quote)),
  );
}
export function validateGroundedReview(
  input: TailoringInput,
  proposalValue: unknown,
  review?: GroundedReview,
): TailoringProposal {
  const proposal = validateTailoringProposal(input, proposalValue);
  const claims = [...proposal.rewrites, ...proposal.essayClaims];
  if (!review && claims.every((claim) => extractive(input, claim))) return proposal;
  if (review) review = groundedReviewSchema.parse(review);
  if (
    review?.independent !== true ||
    review.sourceDigest !== input.sourceDigest ||
    review.inputHash !== input.inputHash ||
    review.proposalHash !== tailoringHash(proposal) ||
    !review.reviewer.trim() ||
    !Number.isFinite(Date.parse(review.reviewedAt))
  )
    throw new Error("Paraphrase requires independent grounded claim review");
  if (
    review.claims.length !== claims.length ||
    new Set(review.claims.map((item) => item.claimId)).size !== claims.length
  )
    throw new Error("Grounded review must cover every claim once");
  for (const claim of claims) {
    const decision = review.claims.find((item) => item.claimId === claim.id);
    const citations = claim.citations.map((item) => item.factId).sort();
    if (
      decision?.decision !== "supported" ||
      !decision.rationale.trim() ||
      JSON.stringify([...decision.factIds].sort()) !== JSON.stringify(citations)
    )
      throw new Error("Unsupported or unreviewed qualification remains held");
  }
  return proposal;
}
export function applyReviewedProposal(data: ResumeData, reviewed: ReviewedProposal): ResumeData {
  if (tailoringHash(resumeDataSchema.parse(data)) !== reviewed.input.baseDataHash)
    throw new Error("Resume facts changed after proposal");
  const rebuilt = buildTailoringInput(data, reviewed.input);
  if (rebuilt.inputHash !== reviewed.input.inputHash)
    throw new Error("Source facts differ from frozen resume");
  const proposal = validateGroundedReview(reviewed.input, reviewed.proposal, reviewed.review);
  const next = structuredClone(data);
  for (const rewrite of proposal.rewrites) {
    const fact = reviewed.input.facts.find((item) => item.id === rewrite.targetFactId)!;
    const [, section, entry, , bullet] = fact.pointer.split("/");
    const entries = section === "experience" ? next.experience : next.projects;
    if (entries[Number(entry)]?.bullets[Number(bullet)] !== fact.quote)
      throw new Error("Source bullet changed after proposal");
    entries[Number(entry)]!.bullets[Number(bullet)] = rewrite.text;
  }
  return next;
}
