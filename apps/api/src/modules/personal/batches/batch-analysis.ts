import type { PersonalBatchAnalysis } from "@jobpilot/contracts/personal-batch";
import type { ResumeData } from "@jobpilot/contracts/resume";
import { buildFitEvaluation } from "../fit-evaluation";
import { manifestHash } from "../persistence-policy";

export interface BatchContext {
  campaignId: string;
  runId: string;
  evidenceId: string;
  sourceHash: string;
  settingsHash: string;
  base: ResumeData;
  keywords: string[];
}
export interface BatchCandidate {
  id: string;
  identity: string;
  title: string;
  company: string;
  track: PersonalBatchAnalysis["track"];
  postingContentHash: string;
  posting: {
    title: string;
    employer: string;
    descriptionText: string;
    location: string | null;
    deadline: string | null;
  };
}
function member(candidate: BatchCandidate, context: BatchContext) {
  if (!candidate.posting.descriptionText.trim())
    throw new Error("Every member needs a full description");
  const fit = buildFitEvaluation(candidate.posting, { keywords: context.keywords }, context.base);
  if (!fit.postingTerms.length)
    throw new Error("Every member needs posting-supported campaign keywords");
  return {
    recordId: candidate.id,
    identity: candidate.identity,
    title: candidate.title,
    company: candidate.company,
    inputHash: manifestHash({
      identity: candidate.identity,
      title: candidate.title,
      company: candidate.company,
      track: candidate.track,
      postingHash: fit.postingHash,
      sourceContentHash: candidate.postingContentHash,
      postingTerms: fit.postingTerms,
    }),
    postingHash: candidate.postingContentHash,
    postingTerms: fit.postingTerms,
    supportedByBase: fit.supportedByBase,
    absentFromBase: fit.absentFromBase,
  };
}
function overlap(left: string[], right: string[]) {
  const union = new Set([...left, ...right]);
  return union.size ? left.filter((term) => right.includes(term)).length / union.size : 0;
}
export function buildBatchAnalysis(
  context: BatchContext,
  candidates: BatchCandidate[],
): PersonalBatchAnalysis {
  if (
    candidates.length < 3 ||
    candidates.length > 5 ||
    new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
  )
    throw new Error("A batch requires 3–5 unique records");
  const track = candidates[0]!.track;
  if (candidates.some((candidate) => candidate.track !== track))
    throw new Error("Batch members must share one recruiting track");
  const members = candidates
    .map((candidate) => member(candidate, context))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  let minimum = 1;
  for (let left = 0; left < members.length; left++)
    for (let right = left + 1; right < members.length; right++)
      minimum = Math.min(
        minimum,
        overlap(members[left]!.postingTerms, members[right]!.postingTerms),
      );
  if (minimum < 0.6)
    throw new Error(
      "Every pair must share at least 60% of its combined posting-supported campaign keywords",
    );
  const sharedSupportedTerms = members[0]!.supportedByBase
    .filter((term) => members.every((item) => item.supportedByBase.includes(term)))
    .sort();
  const missingTerms = [...new Set(members.flatMap((item) => item.absentFromBase))]
    .sort()
    .map((term) => ({
      term,
      recordIds: members
        .filter((item) => item.absentFromBase.includes(term))
        .map((item) => item.recordId),
    }));
  const sourceQuestion = missingTerms.length
    ? `The approved resume has no evidence for these terms in the selected ${members.length} postings: ${missingTerms.map(({ term }) => term).join(", ")}. If you have relevant experience, identify the original source and exact supporting facts for separate source review; otherwise answer none. This response does not add facts to the accepted resume or authorize their use. New facts require explicit source acceptance and a new batch against that revision.`
    : null;
  return {
    version: 1,
    campaignId: context.campaignId,
    runId: context.runId,
    evidenceId: context.evidenceId,
    sourceHash: context.sourceHash,
    resumeHash: manifestHash(context.base),
    settingsHash: context.settingsHash,
    track,
    overlap: { metric: "pairwise_jaccard", required: 0.6, minimum },
    members,
    sharedSupportedTerms,
    missingTerms,
    sourceQuestion,
  };
}

export function suggestBatchMembers(
  context: BatchContext,
  candidates: BatchCandidate[],
): PersonalBatchAnalysis[] {
  const valid = candidates.flatMap((candidate) => {
    try {
      return [{ candidate, analysis: member(candidate, context) }];
    } catch {
      return [];
    }
  });
  const used = new Set<string>();
  const suggestions: PersonalBatchAnalysis[] = [];
  for (const seed of valid) {
    if (used.has(seed.candidate.id)) continue;
    const group = [seed];
    for (const item of valid) {
      if (group.length === 5) break;
      if (
        used.has(item.candidate.id) ||
        group.some((other) => other.candidate.id === item.candidate.id) ||
        item.candidate.track !== seed.candidate.track
      )
        continue;
      if (
        group.every(
          (other) => overlap(other.analysis.postingTerms, item.analysis.postingTerms) >= 0.6,
        )
      )
        group.push(item);
    }
    if (group.length < 3) continue;
    suggestions.push(
      buildBatchAnalysis(
        context,
        group.map(({ candidate }) => candidate),
      ),
    );
    for (const item of group) used.add(item.candidate.id);
  }
  return suggestions;
}
