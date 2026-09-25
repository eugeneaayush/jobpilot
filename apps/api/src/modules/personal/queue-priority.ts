import type { PersonalRecord } from "@/generated/prisma/client";
import { objectValue } from "./runtime";

type Row = Pick<PersonalRecord, "id" | "title" | "company" | "details">;
function priority(row: Row, now: number): [number, number, number] {
  const details = objectValue(row.details);
  const deadline = Date.parse(String(objectValue(details.posting).deadline ?? ""));
  const urgent = Number.isFinite(deadline) && deadline >= now && deadline <= now + 14 * 86400000;
  let category = 3;
  if (
    /investment|investing|private equity|venture capital|hedge fund|growth equity/i.test(row.title)
  )
    category = 0;
  else if (/product manag|product owner/i.test(row.title)) category = 1;
  else if (/mckinsey|bain & company|boston consulting group|^bcg$/i.test(row.company)) category = 2;
  return [urgent ? deadline : Number.POSITIVE_INFINITY, category, -(Number(details.fitScore) || 0)];
}

export function compareApplicationPriority(a: Row, b: Row, now = Date.now()) {
  const left = priority(a, now);
  const right = priority(b, now);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}
