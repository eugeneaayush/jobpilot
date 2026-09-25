import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type {
  PersonalEligibilityAdjudicationInput,
  PersonalRecoveryContext,
} from "@jobpilot/contracts/personal-recovery";
import { z } from "zod/v4";
import { conflict } from "@/common/errors";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import { manifestHash } from "./persistence-policy";
import { exactPointerValue } from "./readiness-policy";
import { objectValue, textValue } from "./runtime";
import { currentResumeCitationValue, validateScreeningSnapshot } from "./screening-provenance";

const requirementsSchema = z
  .array(
    z.object({
      requirement: z.string().min(1),
      evidence: z.string().min(1),
      status: z.enum(["satisfied", "violated", "unknown"]),
      candidateEvidence: z.string().nullable(),
    }),
  )
  .max(200);
export function recoveryRequirements(details: unknown) {
  const parsed = requirementsSchema.safeParse(
    objectValue(objectValue(details).evaluation).requirements,
  );
  if (!parsed.success) return [];
  return parsed.data.map((requirement, index) => ({
    ...requirement,
    id: manifestHash({
      index,
      requirement: requirement.requirement,
      evidence: requirement.evidence,
    }),
  }));
}
export function recoveryContext(
  record: Pick<PersonalRecord, "identity" | "details">,
  settings: PersonalSettings,
  evidence: Pick<PersonalResumeEvidence, "id" | "sourceHash" | "details">,
): PersonalRecoveryContext {
  const posting = objectValue(objectValue(record.details).posting);
  return {
    identity: record.identity,
    postingHash: textValue(posting.contentHash) || manifestHash(posting),
    settingsHash: manifestHash(settings),
    resumeEvidenceId: evidence.id,
    sourceHash: evidence.sourceHash,
    evidenceHash: manifestHash(evidence.details),
    requirementsHash: manifestHash(recoveryRequirements(record.details)),
  };
}
export function sameRecoveryContext(a: unknown, b: PersonalRecoveryContext) {
  return manifestHash(a) === manifestHash(b);
}
export function activeRecoveryRevision(
  details: unknown,
  campaignId: string,
  runId: string,
  context: PersonalRecoveryContext,
): string | null {
  const ticket = objectValue(objectValue(details).recoveryTicket);
  if (
    ticket.campaignId !== campaignId ||
    ticket.campaignRunId !== runId ||
    !sameRecoveryContext(ticket.context ?? {}, context) ||
    typeof ticket.revision !== "string"
  )
    return null;
  return ticket.revision;
}
export function adjudicatedRequirements(details: unknown, context: PersonalRecoveryContext) {
  const original = recoveryRequirements(details);
  const current = objectValue(objectValue(details).eligibilityAdjudication);
  if (!sameRecoveryContext(current.context ?? {}, context) || !Array.isArray(current.decisions))
    return original;
  const decisions = new Map(
    current.decisions.map((value) => {
      const item = objectValue(value);
      return [item.requirementId, item];
    }),
  );
  return original.map((requirement) => {
    const decision = decisions.get(requirement.id);
    if (!decision || !["satisfied", "violated", "unknown"].includes(String(decision.status)))
      return requirement;
    const citation = objectValue(decision.citation);
    if (
      citation.kind === "screening_answer" &&
      citation.snapshotHash !== objectValue(objectValue(details).screeningAnswers).snapshotHash
    )
      return {
        ...requirement,
        status: "unknown" as const,
        candidateEvidence:
          "Screening answer source changed; review this requirement against the current snapshot",
      };
    return {
      ...requirement,
      status: decision.status as typeof requirement.status,
      candidateEvidence: textValue(decision.rationale),
    };
  });
}
export function overallEligibility(
  requirements: { status: "violated" | "satisfied" | "unknown" }[],
) {
  if (requirements.some((requirement) => requirement.status === "violated"))
    return "ineligible" as const;
  if (!requirements.length || requirements.some((requirement) => requirement.status === "unknown"))
    return "unknown" as const;
  return "eligible" as const;
}
export function validateEligibilityDecision(
  decision: PersonalEligibilityAdjudicationInput["decisions"][number],
  record: Pick<PersonalRecord, "id" | "identity" | "title" | "company" | "details">,
  settings: PersonalSettings,
  evidence: Pick<PersonalResumeEvidence, "id" | "sourceHash" | "details">,
  context: PersonalRecoveryContext,
) {
  const details = objectValue(record.details);
  const requirement = recoveryRequirements(details).find(
    (item) => item.id === decision.requirementId,
  );
  if (!requirement || decision.sourceQuote !== requirement.evidence)
    throw conflict("Decision must cite the exact stored requirement source clause");
  const posting = objectValue(details.posting);
  const source = [
    record.title,
    record.company,
    textValue(posting.descriptionText),
    textValue(posting.deadline),
  ].join("\n");
  if (decision.status !== "unknown" && !source.includes(decision.sourceQuote))
    throw conflict("This generated requirement needs an actual posting clause before adjudication");
  if (!decision.citation) {
    if (decision.status !== "unknown")
      throw conflict("A resolved decision requires an exact stored fact citation");
    return;
  }
  const citation = decision.citation;
  let actual: unknown;
  if (citation.kind === "settings") actual = exactPointerValue(settings, citation.pointer);
  if (citation.kind === "resume") {
    actual = currentResumeCitationValue(evidence, citation.pointer);
  }
  if (citation.kind === "screening_answer") {
    const snapshot = validateScreeningSnapshot(record, settings, evidence);
    if (!snapshot) throw conflict("A current screening answer snapshot is required");
    if (
      snapshot.snapshotHash !== citation.snapshotHash ||
      snapshot.identity !== context.identity ||
      snapshot.postingContentHash !== context.postingHash ||
      snapshot.settingsHash !== context.settingsHash
    )
      throw conflict("Screening answer citation belongs to a different source context");
    const answers = Array.isArray(snapshot.answers) ? snapshot.answers.map(objectValue) : [];
    const matches = answers.filter((answer) => answer.key === citation.key);
    if (matches.length !== 1)
      throw conflict("Screening answer citation must identify one saved answer");
    actual = matches[0]?.value;
  }
  if (
    actual === null ||
    actual === undefined ||
    typeof actual === "object" ||
    actual !== citation.value
  )
    throw conflict(
      "Citation value must exactly match a stored fact without inferred transformations",
    );
}
