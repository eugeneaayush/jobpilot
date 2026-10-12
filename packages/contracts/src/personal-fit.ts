import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const terms = z.array(z.string().min(1));
export const personalFitEvaluationSchema = z
  .object({
    version: z.literal("whole-term-v1"),
    postingHash: hash,
    resumeHash: hash,
    campaignInputsHash: hash,
    draftHash: hash.nullable(),
    postingTerms: terms,
    supportedByBase: terms,
    supportedInDraft: terms,
    supportedButOmitted: terms,
    absentFromBase: terms,
    insufficientEvidence: z.array(
      z.enum([
        "posting_description_missing",
        "no_campaign_terms",
        "no_posting_terms",
        "draft_not_provided",
      ]),
    ),
  })
  .strict();
export type PersonalFitEvaluation = z.infer<typeof personalFitEvaluationSchema>;
