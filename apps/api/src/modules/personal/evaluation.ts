import type { ResumeData } from "@jobpilot/contracts/resume";
import { assessPostingDeadlines } from "./deadline-policy";
import type { DiscoveredPosting } from "./discovery";
import { assessPostingSeniority, type PostingSeniorityAssessment } from "./seniority";
import { jurisdictionWorkAuthorization } from "./work-authorization";

export interface CandidateFacts {
  mbaGraduationYear?: number;
  mbaEnrolled?: boolean;
  workAuthorized?: boolean;
  workAuthorizationCountries?: string[];
  sponsorshipRequired?: boolean;
  availableFullTime?: boolean;
  availableInternship?: boolean;
  yearsExperience?: number;
  citizenship?: string;
  availabilityStart?: string;
  availabilityEnd?: string;
  availabilityNotes?: string;
}
export interface CampaignPrefs {
  restrictedEmployers?: string[];
  preferredLocations?: string[];
  keywords?: string[];
  now?: Date;
  minimumCompensation?: { amount: number; currency: string; period: "hour" | "year" };
}
interface RequirementAssessment {
  requirement: string;
  status: "satisfied" | "violated" | "unknown";
  evidence: string;
  candidateEvidence: string | null;
}
export interface EvaluationResult {
  track: "mba_internship" | "post_mba_fulltime" | "general_professional";
  seniority: PostingSeniorityAssessment;
  eligibility: "eligible" | "ineligible" | "unknown";
  requirements: RequirementAssessment[];
  fitScore: number;
  fitReasons: string[];
  blockers: string[];
}

function calendarDate(value: string | undefined): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : Number.NaN;
}

function graduationDatePrecision(sentence: string): boolean {
  return (
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter|quarter|Q[1-4])\b/i.test(
      sentence,
    ) ||
    /\b(?:in|by|before|after|through|during|from|between)\s+May\b|\bMay\.?\s*(?:\d{1,2},?\s+)?20\d{2}\b|\b20\d{2}\s+May\b|\b20\d{2}[-/]\d{1,2}\b|\b\d{1,2}[-/](?:\d{1,2}[-/])?20\d{2}\b/i.test(
      sentence,
    )
  );
}

function graduationYearMatches(sentence: string, year: number): boolean | undefined {
  const years = [...sentence.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  const range =
    /\b(?:between|from)\s+(20\d{2})\s*(?:and|to|through|until|[-–—])\s*(20\d{2})\b|\b(20\d{2})\s*[-–—]\s*(20\d{2})\b/i.exec(
      sentence,
    );
  if (!range) return years.includes(year);
  const start = Number(range[1] ?? range[3]);
  const end = Number(range[2] ?? range[4]);
  if (years.length !== 2 || start > end) return undefined;
  return year >= start && year <= end;
}

type PostingSection = "qualifications" | "preferred" | "other";

function sectionHeading(value: string, employer: string): PostingSection | null {
  const heading = value
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/[:：\s]+$/, "");
  if (/^you\s+have$/i.test(heading)) return "qualifications";
  if (/^we\s+prefer$/i.test(heading)) return "preferred";
  if (/^you\s+will$/i.test(heading)) return "other";
  if (
    ["working at", "life at"].some(
      (prefix) => heading.toLowerCase() === `${prefix} ${employer.trim().toLowerCase()}`,
    )
  )
    return "other";
  if (
    /^(?:preferred|desired|additional|bonus) (?:qualifications|skills)|^(?:nice|good) to have$/i.test(
      heading,
    )
  )
    return "preferred";
  if (
    /^(?:(?:minimum|basic|required|essential|your)\s+)?(?:qualifications|requirements)(?:\s*(?:&|and)\s*(?:desired\s+)?(?:skills|experience))?$|^(?:what (?:you(?:['’]ll| will)?|we) (?:bring|need|look for)|what we(?:['’]re| are) looking for|who you are|your (?:skills|experience|background))(?:\s+to (?:the (?:team|role)|succeed))?$|^(?:our ideal candidate|work expectations)$/i.test(
      heading,
    )
  )
    return "qualifications";
  if (
    /^(?:benefits|compensation)(?:\s*(?:&|and)\s*(?:benefits|compensation))?\s+for\s+(?:(?:MBA\s+)?interns|(?:full[ -]time\s+|part[ -]time\s+)?(?:employees|team members|members of management))$|^(?:equal (?:employment )?opportunity employer|we pride ourselves on)$/i.test(
      heading,
    )
  )
    return "other";
  if (
    /^(?:(?:key|your|main)\s+)?responsibilities$|^what you(?:['’]ll| will) (?:do|be doing)$|^what (?:we|you) (?:offer|get)$|^(?:about|join|meet) (?:us|the (?:team|role|company))$|^(?:benefits|compensation|salary|perks|our commitment|equal opportunity|how to apply|location|candidate privacy notice|privacy notice|privacy policy|pay and benefits|compensation and benefits)$|^(?:salary|compensation|pay) range$|^(?:hourly|annual|base) compensation for this role is expected to be between$/i.test(
      heading,
    )
  )
    return "other";
  return null;
}

function benefitsParticipationOnly(sentence: string): boolean {
  // This clause describes access to employee benefits, not eligibility for the job.
  // Anchor the whole clause so appended work-authorization or other conditions remain reviewable.
  return /^(?:[-*•]\s*)?(?:interns?|employees?|team members)\s+(?:are|will be|may be)\s+(?:also\s+)?eligible\s+to\s+participate\s+in\s+(?:the\s+)?(?:company(?:['’]s)?\s+)?(?:generous\s+)?benefits?\s+(?:programs?|plans?)(?:,\s*subject\s+to\s+(?:plan\s+)?eligibility\s+requirements)?[.!]?$/i.test(
    sentence,
  );
}

function postingClauses(text: string, employer: string) {
  const clauses: { sentence: string; section: PostingSection }[] = [];
  let section: PostingSection = "other";
  for (const line of text
    .split(/\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const heading = sectionHeading(line, employer);
    if (heading) {
      section = heading;
      continue;
    }
    // Some ATS templates put the first requirement after the heading on the same line.
    const colon = line.search(/[:：]/);
    const inlineHeading = colon >= 0 ? sectionHeading(line.slice(0, colon), employer) : null;
    // Pay/privacy prose ends a qualification list, but still passes through clause parsing:
    // a genuine explicit requirement in the same paragraph must remain visible.
    if (
      /^Within the range, individual pay is determined\b|^(?:hourly|annual|base) (?:compensation|salary|pay)\b|^\p{Sc}\s*\d/u.test(
        line,
      ) ||
      /^(?:the\s+)?(?:actual\s+)?(?:base\s+)?(?:salary|compensation|pay)\s+(?:may|will|can)\s+vary\b|\b(?:is|be) an? (?:affirmative action and )?equal (?:employment )?opportunity employer\b|^For (?:a )?reasonable accommodation request,?\s*please contact\b|\bwe do not make (?:employment|hiring) decisions based on\b|\b(?:all )?qualified applicants (?:will )?receive consideration without regard to\b/i.test(
        line,
      )
    )
      section = "other";
    let content = line;
    if (inlineHeading) {
      section = inlineHeading;
      content = line.slice(colon + 1).trim();
    }
    for (const sentence of content.split(/(?<=[.!?;])\s+/).filter(Boolean)) {
      const parts = sentence.split(
        /(?:,\s*|\s+(?:and|but|with)\s+)(?=(?:must\b|(?:be|have|hold|possess|speak|demonstrate|know|understand|show|maintain)\b|(?:a|an)\s+(?:MBA|bachelor|master|degree|certification)\b|\d+\+?\s+(?:years|yrs)\b|(?:advanced|strong|excellent|fluent)\b))|\s+[–—]\s+(?=(?:previous|prior)\b)/i,
      );
      const inherited = /\bmust\b|\brequired\b/i.test(sentence) && parts.length > 1;
      for (const part of parts) {
        if (benefitsParticipationOnly(part)) {
          section = "other";
          continue;
        }
        clauses.push({ sentence: part, section: inherited ? "qualifications" : section });
      }
    }
  }
  return clauses;
}

export function evaluatePosting(
  posting: Pick<
    DiscoveredPosting,
    "title" | "descriptionText" | "employer" | "location" | "deadline"
  >,
  facts: CandidateFacts,
  prefs: CampaignPrefs,
  resume: ResumeData,
): EvaluationResult {
  const text = `${posting.title}\n${posting.descriptionText}`;
  const mba = /\bMBA\b|master(?:'s|s)? of business administration/i.test(text);
  const internship = /\bintern(?:ship)?\b|summer associate/i.test(posting.title);
  // A degree preference describes qualifications, not a graduate recruiting track.
  const postMbaTitle =
    /\bpost[\s–—-]+MBA\b|\bMBA[\s–—-]+full[\s–—-]*time\b|\bfull[\s–—-]*time[\s–—-]+MBA\b|\bleadership[\s–—-]+development[\s–—-]+(?:program|programme|associate)\b/i.test(
      posting.title,
    );
  const graduatingEntryProgram = posting.descriptionText
    .split(/\n|(?<=[.!?])\s+/)
    .some(
      (sentence) =>
        /\bMBA\b|master(?:'s|s)? of business administration/i.test(sentence) &&
        /\bgraduating\b|\bclass of\b|\b(?:recent|new) (?:MBA )?graduates\b|\bgraduat(?:e|ion) cohort\b/i.test(
          sentence,
        ) &&
        /\bprogram(?:me)?\b/i.test(sentence) &&
        /\bfull[\s–—-]*time\b|\bentry[\s–—-]*level\b|\brotational\b|\bleadership development\b/i.test(
          sentence,
        ),
    );
  let track: EvaluationResult["track"] = "general_professional";
  if (mba && internship) track = "mba_internship";
  else if (mba && !internship && (postMbaTitle || graduatingEntryProgram))
    track = "post_mba_fulltime";
  const requirements: RequirementAssessment[] = [];
  const blockers: string[] = [];
  const add = (
    requirement: string,
    evidence: string,
    actual: boolean | undefined,
    candidateEvidence: string | null = null,
  ) => {
    let status: RequirementAssessment["status"] = "unknown";
    if (actual === true) status = "satisfied";
    if (actual === false) status = "violated";
    requirements.push({ requirement, status, evidence, candidateEvidence });
  };
  const preferredClauses: string[] = [];
  const deadlines = assessPostingDeadlines(posting, (prefs.now ?? new Date()).getTime());
  for (const { sentence, section } of postingClauses(text, posting.employer)) {
    if (
      deadlines.some((deadline) => deadline.administrativeOnly && deadline.sourceQuote === sentence)
    )
      continue;
    const positiveText = sentence.replace(
      /\bnot (?:strictly )?(?:necessary|required)\b|\bno (?:prior )?(?:experience|travel) (?:is )?(?:necessary|required)\b/gi,
      "",
    );
    const optionalClause = positiveText !== sentence;
    const explicitMandatory =
      /\brequir(?:e[ds]?|ements?)\b|\bmust\b|\beligib|\bcandidates? (?:should|are|graduating)\b/i.test(
        positiveText,
      );
    const employerNoSponsorship =
      /(?:cannot|will not|do not|unable to)\s+(?:provide\s+)?sponsor|\bnot eligible for (?:work authorization |visa |employment )?sponsorship\b/i.test(
        sentence,
      );
    const noSponsorship =
      employerNoSponsorship ||
      /no (?:visa )?sponsorship|without[^.!?]{0,35}sponsorship/i.test(sentence);
    const strongMandatory =
      employerNoSponsorship ||
      /\bmust\b|\bmandatory\b|\b(?:is|are|be)\s+(?:strictly\s+)?required\b|\brequired\s+to\b|\brequired[.!]?\s*$|\b(?:we|the (?:company|employer))\s+require\b/i.test(
        positiveText,
      );
    if (optionalClause && !explicitMandatory && !strongMandatory) {
      preferredClauses.push(sentence);
      continue;
    }
    if (optionalClause && (explicitMandatory || strongMandatory)) {
      add("Other stated requirement needs review", sentence, undefined);
      continue;
    }
    const mandatory = section === "qualifications" || explicitMandatory || strongMandatory;
    const explicitPreference = /\bpreferred\b|\bideally\b|\ba plus\b|\bnice to have\b/i.test(
      sentence,
    );
    const preferred = section === "preferred" || explicitPreference;
    if (preferred && !strongMandatory && !(noSponsorship && !explicitPreference)) {
      preferredClauses.push(sentence);
      continue;
    }
    const graduation =
      /(?:graduat(?:e|es|ing|ion)|class of|complet(?:e|ing)[^.!?]{0,35}(?:MBA|degree))[^.!?]{0,90}\b(20\d{2})\b/i.exec(
        sentence,
      );
    const undergraduateEnrollment =
      /\bundergraduates\b|\bundergraduate\b[^.!?]{0,45}\b(?:students?|enrollment|candidates?)\b|\b(?:enrolled|pursuing|completing)\b[^.!?]{0,60}\bbachelor(?:['’]s|s)?\b/i.test(
        sentence,
      );
    if (mandatory && undergraduateEnrollment) add("Undergraduate enrollment", sentence, undefined);
    if (graduation && (mandatory || /graduat(?:ing|ion)|class of/i.test(sentence))) {
      const cohort = sentence.slice(graduation.index);
      // A title's internship season is separate from its graduation cohort.
      const dateContext =
        sentence === posting.title
          ? sentence.replace(
              /\b(?:summer|spring|fall|autumn|winter)(?=\s+(?:20\d{2}\s+)?(?:MBA\s+)?intern(?:ship)?\b)/gi,
              "",
            )
          : sentence;
      const datePrecision = graduationDatePrecision(dateContext);
      const actual =
        facts.mbaGraduationYear === undefined || undergraduateEnrollment || datePrecision
          ? undefined
          : graduationYearMatches(cohort, facts.mbaGraduationYear);
      let candidateEvidence =
        facts.mbaGraduationYear === undefined ? null : String(facts.mbaGraduationYear);
      if (candidateEvidence && datePrecision)
        candidateEvidence += "; graduation month and day are unconfirmed";
      add("Graduation cohort", sentence, actual, candidateEvidence);
    }
    if (
      mandatory &&
      /(?:enrolled|pursuing|current[^.!?]{0,30}student)[^.!?]{0,70}\bMBA\b|\bMBA\b[^.!?]{0,70}(?:enrolled|pursuing|student)/i.test(
        sentence,
      )
    ) {
      add(
        "MBA enrollment",
        sentence,
        facts.mbaEnrolled,
        facts.mbaEnrolled === undefined ? null : String(facts.mbaEnrolled),
      );
      if (
        /\bMBA\b[^.!?]{0,100}\b(?:focus(?:ed|ing)?\s+(?:on|in)|concentrat(?:ed|ing|ion)\s+in|speciali[sz](?:ed|ing|ation)\s+in|(?:a\s+)?(?:focus|concentration|speciali[sz]ation)\s+in)\b/i.test(
          sentence,
        )
      )
        add("MBA study focus needs review", sentence, undefined);
    }
    if (mandatory && /authori[sz](?:ed|ation)[^.!?]{0,50}work|right to work/i.test(sentence)) {
      const authorization = jurisdictionWorkAuthorization(
        posting.location,
        sentence,
        facts.workAuthorized,
        facts.workAuthorizationCountries ?? [],
      );
      add(
        "Work authorization",
        sentence,
        authorization,
        authorization === undefined
          ? null
          : `${authorization}; explicitly supplied countries: ${facts.workAuthorizationCountries?.join(", ")}`,
      );
    }
    if (noSponsorship)
      add(
        "No sponsorship required",
        sentence,
        facts.sponsorshipRequired === undefined ? undefined : !facts.sponsorshipRequired,
        facts.sponsorshipRequired === undefined ? null : String(facts.sponsorshipRequired),
      );
    if (mandatory && /\bcitizen(?:ship)?\b/i.test(sentence))
      add("Citizenship requirement needs review", sentence, undefined, facts.citizenship ?? null);
    const experience =
      /(\d+)\+?\s*(?:years|yrs)(?:\s+of)?\s+(?:relevant |professional |prior )?experience/i.exec(
        sentence,
      );
    if (mandatory && experience)
      add(
        "Minimum experience",
        sentence,
        facts.yearsExperience === undefined
          ? undefined
          : facts.yearsExperience >= Number(experience[1]),
        facts.yearsExperience === undefined ? null : `${facts.yearsExperience} years`,
      );
    const availabilityRange =
      /availab[^.!?]{0,50}?from\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through|until)\s+(\d{4}-\d{2}-\d{2})/i.exec(
        sentence,
      );
    if (mandatory && availabilityRange) {
      const requiredStart = calendarDate(availabilityRange[1]);
      const requiredEnd = calendarDate(availabilityRange[2]);
      const availableStart = calendarDate(facts.availabilityStart);
      const availableEnd = calendarDate(facts.availabilityEnd);
      let actual: boolean | undefined;
      if (
        Number.isFinite(requiredStart) &&
        Number.isFinite(requiredEnd) &&
        requiredStart <= requiredEnd
      ) {
        if (
          (Number.isFinite(availableStart) && availableStart > requiredStart) ||
          (Number.isFinite(availableEnd) && availableEnd < requiredEnd)
        )
          actual = false;
        else if (Number.isFinite(availableStart) && Number.isFinite(availableEnd)) actual = true;
      }
      add(
        "Availability date range",
        sentence,
        actual,
        facts.availabilityStart || facts.availabilityEnd
          ? `Supplied availability: ${facts.availabilityStart ?? "unknown"} through ${facts.availabilityEnd ?? "unknown"}`
          : null,
      );
    }
    if (mandatory && /availab[^.!?]{0,60}(?:full[ -]time|summer|internship)/i.test(sentence)) {
      const actual = internship ? facts.availableInternship : facts.availableFullTime;
      add(
        "Availability",
        sentence,
        actual,
        actual === undefined ? (facts.availabilityNotes ?? null) : String(actual),
      );
    }
    // Unparsed mandatory clauses remain visible and never become implicit authorization.
    if (mandatory && !requirements.some((requirement) => requirement.evidence === sentence))
      add("Other stated requirement needs review", sentence, undefined);
  }
  if (
    prefs.restrictedEmployers?.some(
      (employer) => employer.trim().toLowerCase() === posting.employer.trim().toLowerCase(),
    )
  ) {
    add(
      "Employer restriction",
      posting.employer,
      false,
      "Employer is restricted by campaign preferences",
    );
    blockers.push("Restricted employer");
  }
  for (const deadline of deadlines) {
    let actual: boolean | undefined;
    if (deadline.status === "satisfied") actual = true;
    if (deadline.status === "violated") actual = false;
    add("Application deadline", deadline.sourceQuote, actual, deadline.explanation);
    if (actual === false) blockers.push("Application deadline has passed");
  }
  if (!requirements.length) {
    // Keep a reviewable exact source excerpt, even when the posting has no structured requirements.
    // This is an unknown source-review hold, not an invented qualification or a fit rejection.
    const source = posting.descriptionText.trim() || posting.title;
    for (let offset = 0; offset < source.length; offset += 20000)
      add("Posting eligibility source review", source.slice(offset, offset + 20000), undefined);
  }
  for (const requirement of requirements)
    if (requirement.status === "violated") blockers.push(requirement.requirement);
  let eligibility: EvaluationResult["eligibility"] = "eligible";
  if (requirements.some((requirement) => requirement.status === "unknown")) eligibility = "unknown";
  if (requirements.some((requirement) => requirement.status === "violated"))
    eligibility = "ineligible";
  const corpus = JSON.stringify(resume).toLowerCase();
  const requested = [
    ...new Set((prefs.keywords ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean)),
  ];
  const postingTerms = requested.filter((word) => text.toLowerCase().includes(word));
  const matched = postingTerms.filter((word) => corpus.includes(word));
  let fitScore = 40;
  const fitReasons = [
    "Fit measures textual relevance separately from eligibility; no submission authority is inferred.",
  ];
  for (const clause of preferredClauses)
    fitReasons.push(`Preferred qualification (not a required eligibility condition): ${clause}`);
  if (prefs.minimumCompensation)
    fitReasons.push(
      "Compensation preference is unknown: no structured salary, currency, and pay period were verified.",
    );
  if (postingTerms.length) {
    fitScore += Math.round((45 * matched.length) / postingTerms.length);
    fitReasons.push(
      `Resume supports ${matched.length}/${postingTerms.length} campaign keywords present in the posting: ${matched.join(", ") || "none"}.`,
    );
  } else fitReasons.push("No campaign keywords matched the posting; neutral relevance baseline.");
  if (
    prefs.preferredLocations?.some((location) =>
      posting.location?.toLowerCase().includes(location.toLowerCase()),
    )
  ) {
    fitScore += 10;
    fitReasons.push("Posting location matches a campaign preference.");
  }
  if (mba && facts.mbaEnrolled === true) {
    fitScore += 5;
    fitReasons.push("MBA enrollment is an explicitly supplied candidate fact.");
  }
  return {
    track,
    seniority: assessPostingSeniority(posting),
    eligibility,
    requirements,
    fitScore: Math.min(100, fitScore),
    fitReasons,
    blockers: [...new Set(blockers)],
  };
}
