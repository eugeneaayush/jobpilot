import type { PersonalRecord } from "@/generated/prisma/client";
import { assessPostingSeniority } from "./seniority";

export function recordSeniority(record: Pick<PersonalRecord, "title" | "details">) {
  const details = record.details as Record<string, unknown> | null;
  const posting = details?.posting as Record<string, unknown> | undefined;
  return assessPostingSeniority({
    title: record.title,
    descriptionText: typeof posting?.descriptionText === "string" ? posting.descriptionText : "",
  });
}

export function seniorityParkReason(record: Pick<PersonalRecord, "title" | "details">) {
  const assessment = recordSeniority(record);
  if (assessment.classification === "undergraduate_entry")
    return "Undergraduate entry-level roles are excluded by the graduate/experienced policy";
  if (assessment.classification === "unresolved")
    return `Graduate or experienced professional level needs source evidence: ${assessment.reasons.join("; ")}`;
  return null;
}

export function resumePageLimit(
  record: Pick<PersonalRecord, "title" | "company" | "details">,
): 1 | 2 {
  if (recordSeniority(record).classification !== "experienced_professional") return 1;
  if (/mckinsey|bain & company|boston consulting group|^bcg$/i.test(record.company)) return 1;
  if (
    /investment|investing|private equity|venture capital|hedge fund|growth equity/i.test(
      record.title,
    )
  )
    return 1;
  return 2;
}
