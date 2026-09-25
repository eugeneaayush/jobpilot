type SeniorityEvidence = { field: "title" | "description"; quote: string };

export interface PostingSeniorityAssessment {
  classification:
    | "graduate_recruiting"
    | "experienced_professional"
    | "undergraduate_entry"
    | "unresolved";
  reasons: string[];
  evidence: SeniorityEvidence[];
}

const graduateDegree =
  /\bMBA\b|\bmaster(?:['’]s|s| of)\b|\bPh\.?D\b|\bdoctoral\b|\bpostgraduate\b/i;
const studentRole = /\bintern(?:ship)?\b|\bsummer (?:associate|analyst|consultant)\b/i;
const undergraduateAudience =
  /\bundergrad(?:uate)?(?:s)?\b[^.!?]{0,45}\b(?:students?|candidates?|only|program|intern)\b|\b(?:students?|candidates?)\b[^.!?]{0,45}\bundergrad(?:uate)?\b|\b(?:enrolled|pursuing|completing)\b[^.!?]{0,60}\bbachelor(?:['’]s|s)?\b|\bbachelor(?:['’]s|s)?\b[^.!?]{0,45}\bstudents?\b/i;
const graduateAudience =
  /\b(?:graduate|postgraduate|doctoral) students?\b|\b(?:MBA|master(?:['’]s|s)|Ph\.?D)\b[^.!?]{0,45}\b(?:students?|candidates?|graduates?)\b|\b(?:enrolled|pursuing|completing)\b[^.!?]{0,60}\b(?:MBA|master(?:['’]s|s)|Ph\.?D)\b/i;
const graduateTitle =
  /\bpost[\s–—-]+MBA\b|\bMBA\b[^.!?]{0,45}\b(?:intern(?:ship)?|associate|program(?:me)?|full[ -]?time)\b|\b(?:master(?:['’]s|s)|Ph\.?D|doctoral|postgraduate)\b[^.!?]{0,45}\b(?:intern(?:ship)?|fellowship|program(?:me)?)\b/i;
const earlyCareer =
  /\b(?:entry[ -]level|early[ -]career|new[ -]grad(?:uate)?|recent bachelor(?:['’]s|s)? graduates?|school leaver|undergraduate (?:intern(?:ship)?|program))\b/i;
const professionalExperience =
  /\b(?:[1-9]\d*(?:\s*[-–]\s*\d+)?\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:(?:relevant|professional|industry|work|prior|post[ -]MBA)\s+)*experience|(?:prior|previous|substantial|significant|demonstrated)\s+(?:(?:professional|industry|investment|product management|consulting)\s+)+experience|experience\s+(?:leading|managing|owning)\s+[^.!?]{1,60})\b/i;
const ownershipDuties =
  /(?:\b(?:you (?:will|would)|responsibilities include|responsible for)\b[^.!?]{0,80}\b|^(?:[-•*]\s*)?)(?:own|lead|manage|set|define|drive)\b[^.!?]{0,75}\b(?:roadmap|strategy|team|portfolio|investment decisions|investment recommendations|product vision|budget|client engagements)\b/i;
const graduateLevelWork =
  /\b(?:graduate|MBA|master(?:['’]s|s)|Ph\.?D|doctoral)[ -]?(?:level\s+)?(?:track|cohort|duties|responsibilities|placement|participants?|interns?)\b[^.!?]{0,150}\b(?:professional experience|independent|own|lead|manage|investment recommendations|advanced research)\b/i;
const distinctGraduateTrack =
  /\b(?:separate|dedicated|distinct)\s+(?:graduate|MBA|master(?:['’]s|s)|Ph\.?D|doctoral)\s+track\b/i;

function evidence(posting: { title: string; descriptionText: string }): SeniorityEvidence[] {
  return [
    { field: "title" as const, quote: posting.title.trim() },
    ...posting.descriptionText
      .split(/\n|(?<=[.!?])\s+/)
      .map((quote) => ({ field: "description" as const, quote: quote.trim() })),
  ].filter((item) => item.quote);
}

function affirmative(item: SeniorityEvidence): boolean {
  return !/\b(?:not required|not necessary|not eligible|not available|no (?:prior )?experience|not an? (?:MBA|graduate)|do not|does not|will not|cannot)\b/i.test(
    item.quote,
  );
}

function assessment(
  classification: PostingSeniorityAssessment["classification"],
  reason: string,
  source: SeniorityEvidence[],
): PostingSeniorityAssessment {
  return { classification, reasons: [reason], evidence: source };
}

export function assessPostingSeniority(posting: {
  title: string;
  descriptionText: string;
}): PostingSeniorityAssessment {
  const source = evidence(posting);
  const undergraduate = source.filter((item) => undergraduateAudience.test(item.quote));
  const graduates = source.filter((item) => affirmative(item) && graduateAudience.test(item.quote));
  const graduateWork = source.filter(
    (item) =>
      affirmative(item) &&
      (graduateLevelWork.test(item.quote) || distinctGraduateTrack.test(item.quote)),
  );
  const graduateProgram = source.filter(
    (item) =>
      affirmative(item) &&
      ((item.field === "title" && graduateTitle.test(item.quote)) ||
        (graduateDegree.test(item.quote) &&
          /\b(?:program(?:me)?|cohort|track|intern(?:ship)?|recruits?|recruiting)\b/i.test(
            item.quote,
          ) &&
          /\b(?:students?|candidates?|graduates?|graduating|post[ -]MBA)\b/i.test(item.quote))),
  );
  const undergraduateOnly = undergraduate.filter((item) =>
    /\bonly\b|\bexclusively\b|\bmust\b/i.test(item.quote),
  );
  if (undergraduateOnly.length && graduates.length === 0) {
    return assessment(
      "undergraduate_entry",
      "The posting explicitly targets undergraduate students.",
      undergraduateOnly,
    );
  }
  if (undergraduate.length && graduates.length) {
    if (graduateWork.length) {
      return assessment(
        "graduate_recruiting",
        "The mixed student program states distinct graduate-level work or experience.",
        [...undergraduate, ...graduateWork],
      );
    }
    return assessment(
      "unresolved",
      "The program admits undergraduate and graduate students without evidenced graduate-level work or a distinct graduate track.",
      [...undergraduate, ...graduates],
    );
  }
  if (undergraduate.length) {
    return assessment(
      "undergraduate_entry",
      "The posting targets undergraduate students without a supported graduate track.",
      undergraduate,
    );
  }
  if (graduateProgram.length || (graduates.length && studentRole.test(posting.title))) {
    return assessment(
      "graduate_recruiting",
      "The posting affirmatively identifies postgraduate recruiting or postgraduate student eligibility.",
      graduateProgram.length ? graduateProgram : graduates,
    );
  }
  const entry = source.filter((item) => affirmative(item) && earlyCareer.test(item.quote));
  if (entry.length) {
    return assessment(
      "undergraduate_entry",
      "The posting identifies an entry-level or undergraduate recruiting role without an explicit postgraduate program.",
      entry,
    );
  }
  const experience = source.filter(
    (item) =>
      item.field === "description" &&
      affirmative(item) &&
      !/\b(?:0|zero)\s*(?:[-–]|to)\s*\d+\s*(?:years?|yrs?)\b|\b(?:up to|at most)\s+\d+\s*(?:years?|yrs?)\b/i.test(
        item.quote,
      ) &&
      professionalExperience.test(item.quote),
  );
  const duties = source.filter(
    (item) => item.field === "description" && affirmative(item) && ownershipDuties.test(item.quote),
  );
  if (!studentRole.test(posting.title) && (experience.length || duties.length)) {
    return assessment(
      "experienced_professional",
      "The posting states professional experience or substantive ownership responsibilities; a bachelor's minimum does not exclude it.",
      [...experience, ...duties],
    );
  }
  return assessment(
    "unresolved",
    "The posting does not establish postgraduate recruiting or experienced professional responsibilities.",
    [...graduates, ...graduateWork],
  );
}
