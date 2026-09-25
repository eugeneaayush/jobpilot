import type { PersonalSettings } from "@jobpilot/contracts/personal";
import { jurisdictionWorkAuthorization } from "./work-authorization";

type Status = "satisfied" | "violated" | "unknown";
type Settings = Pick<
  PersonalSettings,
  "recruitingAvailability" | "workAuthorization" | "workAuthorizationCountries" | "citizenship"
>;
type Posting = { title: string; descriptionText: string; location: string | null };
type Requirement = {
  requirement: string;
  status: Status;
  evidence: string;
  candidateEvidence: string | null;
};

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
const monthPattern = `(${months.join("|")})`;
const monthRange = new RegExp(
  `\\b${monthPattern}(?:\\s+(\\d{1,2}),?)?(?:\\s+(20\\d{2}))?\\s*(?:to|through|until|[-–])\\s*${monthPattern}(?:\\s+(\\d{1,2}),?)?\\s+(20\\d{2})\\b`,
  "i",
);
const startMonth = new RegExp(
  `\\b(?:starts?|starting|commences?|begins?|beginning|available from)\\s+(?:(?:in|on|from)\\s+)?${monthPattern}(?:\\s+(\\d{1,2}),?)?\\s+(20\\d{2})\\b`,
  "i",
);
const isoRange =
  /\b(20\d{2}-\d{2})(?:-(\d{2}))?\s*(?:to|through|until|[-–])\s*(20\d{2}-\d{2})(?:-(\d{2}))?\b/i;
const internship =
  /\bintern(?:ship)?\b|\bsummer\s+(?:20\d{2}\s+)?(?:associate|analyst|consultant)\b/i;
const summerYear = /\bsummer\s+(20\d{2})\b|\b(20\d{2})\s+summer\b/gi;
const employmentDate = new RegExp(
  `\\b(?:starts?|starting|ends?|ending|begins?|beginning|commences?|runs?|available|availability|duration)\\b[^.!?]{0,80}(?:${monthPattern}|20\\d{2}-\\d{2}|\\b(?:spring|summer|fall|autumn|winter)\\b|\\b\\d+\\s+weeks?\\b)`,
  "i",
);
const unrelatedSchedule =
  /\b(?:applications?|apply|deadlines?|interviews?|graduation|graduating|orientation|training|onboarding|courses?|previous|prior|other|another|separate|undergraduate)\b/i;
const programSubject = "(?:internship(?:\\s+program)?|(?:this|our|the)\\s+(?:MBA\\s+)?program)";
const programStart = new RegExp(
  `\\b${programSubject}\\s+(?:start(?:s| date)?|starting|begins?|commences?)\\s*:?\\s*(?:(?:in|on)\\s+)?(?:(early|mid|late)[ -])?${monthPattern}(?:\\s+(\\d{1,2}),?)?\\s+(20\\d{2})\\b`,
  "gi",
);
const programStartHint = new RegExp(
  `\\b${programSubject}\\b[^.!?]{0,30}\\b(?:start(?:s| date)?|starting|begins?|commences?)\\b`,
  "i",
);
const fixedWeeks = new RegExp(
  `\\b(\\d{1,2})(?:\\s*[-–]\\s*|\\s+)weeks?\\s+(?:(?:paid|full[ -]time|MBA|summer)\\s+)*(?:internship|program)\\b|\\b${programSubject}\\s+(?:duration\\s*:\\s*|(?:runs?|lasts?|is|will last|will run)(?:\\s+for)?\\s+)(\\d{1,2})\\s+weeks?\\b`,
  "gi",
);
const uncertainSchedule =
  /\b(?:not|never|tentative|approximately|about|around|at least|up to|minimum|maximum|flexible|variable|optional|or|could|might|extend(?:s|ed)?|extension|subject to change|may start|may last|may run)\b|\b\d+\s*(?:[-–]|to)\s*\d+\s*[- ]?weeks?\b/i;

function durationSchedule(clauses: string[], approvedStart: string, approvedEnd: string) {
  const starts = new Set<string>();
  const durations = new Set<number>();
  const evidence: string[] = [];
  let ambiguous = false;
  for (const clause of clauses) {
    if (unrelatedSchedule.test(clause)) continue;
    const startMatches = Array.from(clause.matchAll(programStart));
    const durationMatches = Array.from(clause.matchAll(fixedWeeks));
    const startHint = programStartHint.test(clause);
    const durationHint =
      /\b(?:internship|program)\b/i.test(clause) && /\b(?:weeks?|duration)\b/i.test(clause);
    if (!startHint && !durationHint) continue;
    evidence.push(clause);
    if (
      uncertainSchedule.test(clause) ||
      (startHint && !startMatches.length) ||
      (durationHint && !durationMatches.length)
    )
      ambiguous = true;
    const namedDates = Array.from(clause.matchAll(new RegExp(`${monthPattern}\\b`, "gi")));
    if (startMatches.length && namedDates.length !== startMatches.length) ambiguous = true;
    for (const match of startMatches) {
      const month = monthValue(match[2]!, match[4]!);
      const lastDay = new Date(
        Date.UTC(Number(match[4]), months.indexOf(match[2]!.toLowerCase()) + 1, 0),
      ).getUTCDate();
      if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > lastDay)) ambiguous = true;
      starts.add(`${month}|${match[1]?.toLowerCase() ?? ""}|${match[3] ?? ""}`);
    }
    for (const match of durationMatches) durations.add(Number(match[1] ?? match[2]));
  }
  const start = [...starts][0]?.split("|")[0];
  const weeks = [...durations][0];
  if (ambiguous || starts.size !== 1 || durations.size !== 1 || !start || !weeks)
    return { satisfied: false, evidence: evidence.join("\n"), note: null };
  const [year, month] = start.split("-").map(Number);
  // Bound the whole source month, including early/late wording, without assigning a day.
  const latestEnd = new Date(Date.UTC(year!, month!, 0) + weeks * 7 * 86_400_000)
    .toISOString()
    .slice(0, 7);
  return {
    satisfied: start >= approvedStart && latestEnd <= approvedEnd,
    evidence: evidence.join("\n"),
    note: `bounded inference from source-stated ${start} start and ${weeks}-week duration; every possible day of the start month plus that duration falls within approved months; exact employer dates and boundary days unconfirmed`,
  };
}

function monthValue(name: string, year: string): string {
  return `${year}-${String(months.indexOf(name.toLowerCase()) + 1).padStart(2, "0")}`;
}

function range(text: string) {
  const iso = isoRange.exec(text);
  if (iso)
    return { start: iso[1]!, end: iso[3]!, startDay: Boolean(iso[2]), endDay: Boolean(iso[4]) };
  const named = monthRange.exec(text);
  if (!named) return null;
  return {
    start: monthValue(named[1]!, named[3] ?? named[6]!),
    end: monthValue(named[4]!, named[6]!),
    startDay: Boolean(named[2]),
    endDay: Boolean(named[5]),
  };
}

function englishProse(text: string): boolean {
  const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
  const markers = new Set(
    words.filter((word) =>
      [
        "the",
        "and",
        "you",
        "of",
        "this",
        "with",
        "to",
        "are",
        "will",
        "must",
        "for",
        "our",
      ].includes(word),
    ),
  );
  return words.length >= 12 && markers.size >= 4;
}

const nonWageContext =
  /\b(?:reimburse(?:ment|ments|d)?|expenses?|(?:paid\s+)?time off|PTO|benefits?[ -]only|customers?|clients?|pricing|prices?|fees?|tuition|deductibles?)\b/i;
const benefitsHeading = /^\s*benefits?(?:\s+(?:programs?|allowance))?\s*:?\s*$/im;
const uncompensatedRole =
  /\b(?:this|the|our)\s+(?:(?:MBA|summer|full[ -]time|part[ -]time)\s+)*(?:internship|role|position|placement|program)\s+(?:(?:is|will be)\s+(?:not compensated|uncompensated|without remuneration)|(?:has|offers|provides)\s+no\s+remuneration)\b|\b(?:interns?|employees?|participants?)\s+(?:are|will be)\s+(?:not compensated|uncompensated)\b|\bno\s+remuneration\s+(?:is|will be)\s+(?:provided|offered|paid)\s+for\s+(?:this|the|our)\s+(?:internship|role|position|placement|program)\b/i;
const wageLabel =
  /^(?:hourly|monthly|annual(?:ized)?|yearly)\s+(?:(?:MBA|intern(?:ship)?|base)\s+)*(?:pay|salary|wages?|compensation)(?:\s+(?:rate|range))?\s*:?$/i;
const wageAmount =
  /^(?:([$£€])\s*|(USD|EUR|GBP)\s+)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?:\s*[-–—]\s*([$£€])?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?))?(?:\s+(USD|EUR|GBP))?$/i;

function labeledPay(source: string) {
  const lines = Array.from(source.matchAll(/[^\r\n]+/g)).filter((line) => line[0].trim());
  let paid: string | null = null;
  let zero: string | null = null;
  for (let index = 0; index < lines.length - 1; index++) {
    const label = lines[index]!;
    if (!wageLabel.test(label[0].trim())) continue;
    const preceding = lines[index - 1]?.[0] ?? "";
    if (
      nonWageContext.test(preceding) ||
      benefitsHeading.test(preceding) ||
      /\bunpaid\b|\bnot compensated\b/i.test(preceding)
    )
      continue;
    const amountLine = lines[index + 1]!;
    // Decode known punctuation only; retain the original block for source evidence.
    const normalized = amountLine[0]
      .trim()
      .replace(/&(?:mdash|ndash);|&#821[12];|&#x201[34];/gi, "–");
    const amount = wageAmount.exec(normalized);
    if (!amount) continue;
    const symbolCurrency = { $: "USD", "£": "GBP", "€": "EUR" };
    const symbol = amount[1] as keyof typeof symbolCurrency | undefined;
    const currency = amount[2]?.toUpperCase() ?? (symbol ? symbolCurrency[symbol] : undefined);
    if ((amount[4] && amount[4] !== symbol) || (amount[6] && amount[6].toUpperCase() !== currency))
      continue;
    const minimum = Number(amount[3]!.replaceAll(",", ""));
    const maximum = Number((amount[5] ?? amount[3]!).replaceAll(",", ""));
    const evidence = source.slice(label.index, amountLine.index! + amountLine[0].length);
    if (minimum === 0 || maximum === 0) zero ??= evidence;
    else if (Number.isFinite(minimum) && Number.isFinite(maximum) && minimum <= maximum)
      paid ??= evidence;
  }
  return { paid, zero };
}

export function assessRecruitingConstraints(
  posting: Posting,
  settings: Settings,
): { decision: Status; requirements: Requirement[] } {
  const requirements: Requirement[] = [];
  const clauses = posting.descriptionText
    .split(/\n|(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const source = posting.descriptionText.trim() || posting.title;
  const add = (
    requirement: string,
    status: Status,
    evidence: string,
    candidateEvidence: string | null = null,
  ) => {
    requirements.push({ requirement, status, evidence, candidateEvidence });
  };
  const approved = settings.recruitingAvailability;
  if (!approved) {
    add(
      "Recruiting availability",
      "unknown",
      source,
      "Approved recruiting constraints have not been supplied",
    );
    return { decision: "unknown", requirements };
  }
  const roleText = `${posting.title}\n${posting.descriptionText}`;
  if (
    /\bpart[ -]time\b/i.test(roleText) &&
    !/\bfull[ -]time\b|\bpermanent\b/i.test(posting.title)
  ) {
    const partTimeEvidence = /\bpart[ -]time\b/i.test(posting.title)
      ? posting.title
      : clauses.find((clause) => /\bpart[ -]time\b/i.test(clause))!;
    let availabilityStatus: Status = approved.partTimeNow ? "satisfied" : "violated";
    if (/\bfull[ -]time\b|\bpermanent\b/i.test(roleText)) availabilityStatus = "unknown";
    add(
      "Recruiting availability",
      availabilityStatus,
      partTimeEvidence,
      `Current part-time availability: ${approved.partTimeNow}`,
    );
    const hours = clauses
      .map((clause) => ({
        clause,
        match: /\b(?:(\d+)\s*(?:[-–]|to)\s*)?(\d+)\s*(?:hours?|hrs?)\s*(?:per|a|\/)\s*week\b/i.exec(
          clause,
        ),
      }))
      .find((item) => item.match);
    let hoursStatus: Status = "unknown";
    if (hours?.match) {
      if (Number(hours.match[2]) > approved.partTimeMaxHours) hoursStatus = "violated";
      else if (!/\bat least\b|\bminimum\b|\bor more\b/i.test(hours.clause))
        hoursStatus = "satisfied";
    }
    add(
      "Part-time hours",
      hoursStatus,
      hours?.clause ?? source,
      `Maximum ${approved.partTimeMaxHours} hours per week`,
    );
    const location = posting.location?.trim();
    const nycAllowed = approved.partTimeLocations.some((value) =>
      /\bNYC\b|\bNew York(?: City)?\b/i.test(value),
    );
    const remoteAllowed = approved.partTimeLocations.some(
      (value) => /remote/i.test(value) && /\bUS\b|United States/i.test(value),
    );
    const nyc = Boolean(
      location &&
        /\bNYC\b|\bNew York(?: City)?(?:,\s*NY)?\b/i.test(location) &&
        !/New York State/i.test(location),
    );
    const remoteUs = Boolean(
      location &&
        /\bremote\b/i.test(location) &&
        jurisdictionWorkAuthorization(location, "", true, ["US"]) === true,
    );
    let locationStatus: Status = "unknown";
    const mixedLocation = Boolean(location && /\bor\b|\band\b|[;|/]/i.test(location));
    if (!mixedLocation && ((nycAllowed && nyc) || (remoteAllowed && remoteUs)))
      locationStatus = "satisfied";
    else if (
      location &&
      !mixedLocation &&
      !/^(?:remote|hybrid|flexible|multiple locations)$/i.test(location)
    )
      locationStatus = "violated";
    add(
      "Part-time location",
      locationStatus,
      location ?? source,
      approved.partTimeLocations.join("; "),
    );
  } else if (internship.test(posting.title)) {
    const dates = clauses
      .map((clause) => ({ clause, interval: range(clause) }))
      .find((item) => item.interval && !unrelatedSchedule.test(item.clause));
    let status: Status = "unknown";
    let evidence = dates?.clause ?? source;
    let seasonalMatch = false;
    let durationNote: string | null = null;
    const interval = dates?.interval;
    if (
      interval &&
      approved.internshipStartMonth &&
      approved.internshipEndMonth &&
      interval.start <= interval.end
    ) {
      if (
        interval.start < approved.internshipStartMonth ||
        interval.end > approved.internshipEndMonth
      )
        status = "violated";
      else if (
        !(interval.startDay && interval.start === approved.internshipStartMonth) &&
        !(interval.endDay && interval.end === approved.internshipEndMonth)
      )
        status = "satisfied";
    }
    if (!interval) {
      const bounded =
        approved.internshipStartMonth && approved.internshipEndMonth
          ? durationSchedule(clauses, approved.internshipStartMonth, approved.internshipEndMonth)
          : null;
      if (bounded?.evidence) evidence = bounded.evidence;
      if (bounded?.satisfied) {
        status = "satisfied";
        durationNote = bounded.note;
      }
      const years = new Set(
        Array.from(posting.title.matchAll(summerYear), (match) => match[1] ?? match[2]!),
      );
      const datedSchedule = clauses.some(
        (clause) => employmentDate.test(clause) && !unrelatedSchedule.test(clause),
      );
      const year = [...years][0];
      if (
        years.size === 1 &&
        year &&
        !bounded?.evidence &&
        !datedSchedule &&
        approved.internshipStartMonth &&
        approved.internshipEndMonth &&
        jurisdictionWorkAuthorization(posting.location, "", true, ["US"]) === true
      ) {
        evidence = posting.title;
        // Match the stated season only; do not manufacture employer start or end dates.
        if (
          approved.internshipStartMonth <= `${year}-05` &&
          approved.internshipEndMonth >= `${year}-09`
        ) {
          status = "satisfied";
          seasonalMatch = true;
        } else if (
          approved.internshipEndMonth < `${year}-05` ||
          approved.internshipStartMonth > `${year}-09`
        )
          status = "violated";
      }
    }
    add(
      "Recruiting availability",
      status,
      evidence,
      `Approved internship months: ${approved.internshipStartMonth ?? "unknown"} through ${approved.internshipEndMonth ?? "unknown"}; ${durationNote ?? (seasonalMatch ? "matches the US summer year stated in the title; exact employer dates and boundary days unconfirmed" : "exact boundary days unconfirmed")}`,
    );
  } else if (/\bfull[ -]time\b|\bpermanent\b/i.test(roleText)) {
    const dated = clauses
      .map((clause) => ({ clause, match: startMonth.exec(clause) }))
      .find(
        (item) =>
          item.match && !/\b(?:application|applications|apply|deadline)\b/i.test(item.clause),
      );
    let status: Status = "unknown";
    if (dated?.match && approved.permanentStartMonth) {
      const month = monthValue(dated.match[1]!, dated.match[3]!);
      if (month < approved.permanentStartMonth) status = "violated";
      else if (month > approved.permanentStartMonth || !dated.match[2]) status = "satisfied";
    }
    add(
      "Recruiting availability",
      status,
      dated?.clause ?? source,
      `Permanent employment from ${approved.permanentStartMonth ?? "unknown"}; exact first day unconfirmed`,
    );
  } else {
    add(
      "Recruiting availability",
      "unknown",
      source,
      "Posting employment type and dates need source review",
    );
  }
  if (approved.paidOnly) {
    const labeled = labeledPay(source);
    const unpaid =
      clauses.find(
        (clause) =>
          uncompensatedRole.test(clause) ||
          /\bunpaid\s+(?:internship|role|position|work|placement|program)\b|\b(?:internship|role|position|program)\b[^.!?]{0,25}\bunpaid\b|\b(?:not|no)\s+(?:a\s+)?paid\b|\bcommission[ -]only\b|\b100%\s*commission\b|\b(?:no|without)\s+(?:(?:base\s+)?salary|pay|compensation)\b|\b(?:salary|pay|compensation|stipend)\b[^.!?]{0,30}[$£€]\s*0(?:\.00)?\s*(?:per|\/)\s*(?:hour|year|month|week)\b/i.test(
            clause,
          ),
      ) ?? labeled.zero;
    const rangeEvidence =
      /\b(?:expected hourly range|(?:base )?(?:salary|pay|compensation) range)\s+for\s+this\s+(?:role|position)\b[\s\S]{0,600}?[$£€]\s*[1-9][\d,.]*(?:\s*(?:[-–—]|&mdash;|&ndash;)\s*[$£€]?\s*[1-9][\d,.]*)?\s*(?:USD|EUR|GBP)\b/i.exec(
        source,
      )?.[0];
    const compensationBlock =
      rangeEvidence && !nonWageContext.test(rangeEvidence) && !benefitsHeading.test(rangeEvidence)
        ? rangeEvidence
        : null;
    const paidProgram = clauses.find(
      (clause) =>
        /\bpaid\s+(?:MBA\s+)?program\b/i.test(clause) &&
        /(?:[$£€]\s*[1-9][\d,.]*|(?:USD|EUR|GBP)\s*[1-9][\d,.]*)(?:[km])?\+?\s+(?:annual(?:ized)?\s+)?base\s+salary\b/i.test(
          clause,
        ) &&
        !/\b(?:not|no|never|without|unpaid|optional|previous|prior|formerly|was|were|may|might)\b/i.test(
          clause,
        ),
    );
    const paid =
      labeled.paid ??
      compensationBlock ??
      paidProgram ??
      clauses.find(
        (clause) =>
          /\bpaid\s+(?:(?:MBA|part[ -]time|full[ -]time|summer)\s+)?(?:internship|role|position|placement)\b/i.test(
            clause,
          ) ||
          (!nonWageContext.test(clause) &&
            /\b(?:salary|wage|pay|compensation|stipend)\b[^.!?]{0,80}(?:[$£€]\s*\d|(?:USD|EUR|GBP)\s*\d)|[$£€]\s*\d[\d,.]*(?:\s*[-–]\s*[$£€]?\s*\d[\d,.]*)?\s*(?:per|\/)\s*(?:hour|year|month|week)\b/i.test(
              clause,
            )),
      );
    let status: Status = "unknown";
    if (unpaid) status = "violated";
    else if (paid) status = "satisfied";
    add(
      "Paid compensation",
      status,
      unpaid ?? paid ?? source,
      "Paid roles only; no compensation floor supplied",
    );
  }
  if (approved.englishSufficientOnly) {
    const foreignLanguage =
      /\b(?:French|Spanish|Mandarin|Cantonese|Chinese|Japanese|German|Korean|Arabic|Portuguese|Russian|Hindi|Italian|Dutch|Swedish|Danish|Norwegian|Polish|Turkish|Hebrew|Vietnamese|Thai|Indonesian|Bahasa|Bengali|Farsi|Persian|Tagalog|local language|bilingual|additional language)\b/i;
    const requiredLanguage = clauses.find(
      (clause) =>
        foreignLanguage.test(clause) &&
        /\brequired\b|\bmust\b|\bessential\b|\bmandatory\b|\bnecessary\b|\bfluen(?:t|cy)\b|\bproficien(?:t|cy)\b|\bnative\b/i.test(
          clause,
        ) &&
        (!/\bpreferred\b|\ba plus\b|\boptional\b|\bnot required\b/i.test(clause) ||
          /\bmust\b/i.test(clause)),
    );
    const english = clauses.find((clause) =>
      /\bEnglish\s+(?:is\s+)?(?:sufficient|only)\b|\bonly\s+English\b|\bno other languages?\s+(?:are\s+)?required\b/i.test(
        clause,
      ),
    );
    const prose = source.slice(0, 20_000);
    let status: Status = "unknown";
    let rationale = "English sufficiency needs source review; candidate fluency is not inferred";
    if (!requiredLanguage && (english || englishProse(prose))) {
      status = "satisfied";
      rationale = english
        ? "Posting explicitly supports English sufficiency"
        : "No additional language requirement observed in English posting";
    }
    add("English sufficiency", status, requiredLanguage ?? english ?? prose, rationale);
  }
  const authorization = jurisdictionWorkAuthorization(
    posting.location,
    "",
    settings.workAuthorization ?? undefined,
    settings.workAuthorizationCountries,
  );
  if (authorization === true) {
    add(
      "Work authorization",
      "satisfied",
      posting.location ?? source,
      `Explicit work authorization for posting jurisdiction: ${settings.workAuthorizationCountries.join(", ")}`,
    );
  } else if (
    approved.employerSupportedInternational &&
    jurisdictionWorkAuthorization(posting.location, "", true, ["US"]) !== true
  ) {
    const sponsor = clauses.find(
      (clause) =>
        /\b(?:visa|work permit)\s+sponsorship\b[^.!?]{0,45}\b(?:available|provided|offered)\b|\b(?:we|employer|company)\s+(?:will\s+)?(?:provide|offer|sponsor)\b[^.!?]{0,40}\b(?:visa|work permit)\b/i.test(
          clause,
        ) && !/\b(?:not|no|cannot|unable|may|might)\b/i.test(clause),
    );
    const restricted = clauses.find(
      (clause) =>
        /\b(?:citizens?|citizenship|nationality)\b/i.test(clause) &&
        /\b(?:must|required|only)\b/i.test(clause),
    );
    const noSponsor = clauses.find((clause) =>
      /\bno (?:visa )?sponsorship\b|\b(?:cannot|unable to|will not|do not)\s+(?:provide\s+|offer\s+)?sponsor/i.test(
        clause,
      ),
    );
    let status: Status = "unknown";
    if (noSponsor) status = "violated";
    const knownLocation = ["CA", "GB", "IE", "DE", "FR", "AU", "NZ", "SG", "HK", "IN"].some(
      (country) => jurisdictionWorkAuthorization(posting.location, "", true, [country]) === true,
    );
    if (sponsor && settings.citizenship?.trim() && knownLocation && !restricted && !noSponsor)
      status = "satisfied";
    add(
      "Employer-supported international route",
      status,
      noSponsor ?? restricted ?? sponsor ?? posting.location ?? source,
      settings.citizenship
        ? `Explicit citizenship: ${settings.citizenship}; employer sponsorship evidence does not establish existing foreign work authorization`
        : "Candidate citizenship and employer-supported route require verification",
    );
  } else {
    add(
      "Work authorization",
      authorization === false ? "violated" : "unknown",
      posting.location ?? source,
      "Existing work authorization must be explicitly established for the posting's jurisdiction",
    );
  }
  let decision: Status = "satisfied";
  if (requirements.some((item) => item.status === "unknown")) decision = "unknown";
  if (requirements.some((item) => item.status === "violated")) decision = "violated";
  return { decision, requirements };
}
