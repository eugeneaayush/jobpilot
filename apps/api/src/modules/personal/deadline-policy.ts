interface DeadlineAssessment {
  sourceQuote: string;
  status: "satisfied" | "violated" | "unknown";
  precision: "instant" | "date_only" | "unknown";
  calendarDate: string | null;
  explanation: string;
  administrativeOnly: boolean;
}

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const hour = 60 * 60 * 1000;

function validDay(year: number, month: number, day: number): number {
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : Number.NaN;
}

function dateOnly(value: string): number {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(value);
  if (!named) return Number.NaN;
  const month = months.indexOf(named[1].toLowerCase()) + 1;
  return month ? validDay(Number(named[3]), month, Number(named[2])) : Number.NaN;
}

function assessDate(
  value: string,
  sourceQuote: string,
  administrativeOnly: boolean,
  now: number,
): DeadlineAssessment {
  const result: DeadlineAssessment = {
    sourceQuote,
    status: "unknown",
    precision: "unknown",
    calendarDate: null,
    explanation:
      "Employer deadline timing is incomplete or ambiguous; verify the source, not a personal answer.",
    administrativeOnly,
  };
  const day = dateOnly(value);
  if (Number.isFinite(day)) {
    result.precision = "date_only";
    result.calendarDate = new Date(day).toISOString().slice(0, 10);
    // Bound all possible local closing times without assigning the employer a timezone.
    if (now < day - 14 * hour) {
      result.status = "satisfied";
      result.explanation =
        "Before the stated closing date in every timezone; the employer's closing time and timezone are unspecified.";
    } else if (now >= day + 36 * hour) {
      result.status = "violated";
      result.explanation =
        "The stated closing date has ended in every timezone; the employer's closing time and timezone are unspecified.";
    } else {
      result.explanation =
        "The stated closing date may have begun or ended in the employer's timezone; verify its closing time before applying.";
    }
    return result;
  }
  const instant =
    /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  const timestamp =
    instant && Number.isFinite(dateOnly(instant[1])) ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(timestamp)) {
    result.precision = "instant";
    result.calendarDate = instant?.[1] ?? null;
    result.status = timestamp >= now ? "satisfied" : "violated";
    result.explanation = "Compared with the employer's explicitly offset closing timestamp.";
  }
  return result;
}

export function assessPostingDeadlines(
  posting: { descriptionText: string; deadline: string | null },
  now = Date.now(),
): DeadlineAssessment[] {
  const results: DeadlineAssessment[] = [];
  if (posting.deadline)
    results.push(assessDate(posting.deadline.trim(), posting.deadline, false, now));
  for (const match of posting.descriptionText.matchAll(
    /\bThis role will remain open until\b[^\n.!?]*(?:[.!?]|$)/gi,
  )) {
    const quote = match[0].trim();
    const timing = quote
      .replace(/^This role will remain open until\s*/i, "")
      .replace(/[.!?]$/, "")
      .trim();
    const dateText = timing.replace(/\s+and we will review all applications at that time$/i, "");
    const administrativeOnly =
      /^(?:[a-z]+\s+\d{1,2}(?:,?\s+\d{4})?|[a-z]+\s+\d{4}|\d{1,4}(?:[-/]\d{1,4}){1,2})$/i.test(
        dateText,
      );
    // Mixed clauses stay reviewable; a recognizable leading date cannot erase another condition.
    results.push(assessDate(dateText, quote, administrativeOnly, now));
  }
  return results;
}
