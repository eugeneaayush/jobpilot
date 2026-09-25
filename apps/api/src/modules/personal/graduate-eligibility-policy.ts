import type { PersonalSettings } from "@jobpilot/contracts/personal";
import { personalEligibilityAdjudicationSchema } from "@jobpilot/contracts/personal-recovery";
import { conflict } from "@/common/errors";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import {
  adjudicatedRequirements,
  recoveryContext,
  recoveryRequirements,
  sameRecoveryContext,
  validateEligibilityDecision,
} from "./recovery-policy";
import { assessRecruitingConstraints } from "./recruiting-constraints";
import { objectValue, textValue } from "./runtime";

export function verifyRecruitingConstraints(
  record: PersonalRecord,
  settings: PersonalSettings,
  evidence: PersonalResumeEvidence,
): void {
  if (!settings.recruitingAvailability)
    throw conflict("Approved recruiting availability is required before submission.");
  const details = objectValue(record.details);
  const posting = objectValue(details.posting);
  const fresh = assessRecruitingConstraints(
    {
      title: record.title,
      descriptionText: textValue(posting.descriptionText),
      location: typeof posting.location === "string" ? posting.location : null,
    },
    settings,
  );
  const context = recoveryContext(record, settings, evidence);
  const stored = recoveryRequirements(details);
  const saved = objectValue(details.eligibilityAdjudication);
  const review = personalEligibilityAdjudicationSchema.safeParse({
    expectedUpdatedAt: record.updatedAt.toISOString(),
    context: saved.context,
    decisions: saved.decisions,
  });
  const effective = adjudicatedRequirements(details, context);
  for (const requirement of fresh.requirements) {
    if (requirement.status === "satisfied") continue;
    if (requirement.status === "violated")
      throw conflict(`Recruiting constraint violated: ${requirement.requirement}`);
    const matches = stored.filter(
      (item) =>
        item.requirement === requirement.requirement && item.evidence === requirement.evidence,
    );
    if (
      matches.length !== 1 ||
      !review.success ||
      !sameRecoveryContext(review.data.context, context)
    )
      throw conflict(
        `Recruiting constraint needs current source review: ${requirement.requirement}`,
      );
    const current = effective.find((item) => item.id === matches[0]!.id);
    const decision = review.data.decisions.find((item) => item.requirementId === matches[0]!.id);
    if (current?.status !== "satisfied" || !decision)
      throw conflict(`Recruiting constraint remains unknown: ${requirement.requirement}`);
    const availabilityPointers = ["/availabilityNotes"];
    const candidateEvidence = requirement.candidateEvidence ?? "";
    if (candidateEvidence.startsWith("Approved internship months:"))
      availabilityPointers.push(
        "/recruitingAvailability/internshipStartMonth",
        "/recruitingAvailability/internshipEndMonth",
      );
    if (candidateEvidence.startsWith("Permanent employment from"))
      availabilityPointers.push("/recruitingAvailability/permanentStartMonth");
    if (candidateEvidence.startsWith("Current part-time availability:"))
      availabilityPointers.push("/recruitingAvailability/partTimeNow");
    const allowedPointers: Record<string, string[]> = {
      "Recruiting availability": availabilityPointers,
      "Part-time hours": ["/recruitingAvailability/partTimeMaxHours", "/availabilityNotes"],
      "Part-time location": ["/availabilityNotes"],
    };
    const citation = decision.citation;
    if (
      citation?.kind !== "settings" ||
      !allowedPointers[requirement.requirement]?.includes(citation.pointer)
    )
      throw conflict(
        `Recruiting constraint requires relevant source evidence: ${requirement.requirement}`,
      );
    // Candidate preferences cannot establish an employer's pay, language, or sponsorship terms.
    validateEligibilityDecision(decision, record, settings, evidence, context);
  }
}
