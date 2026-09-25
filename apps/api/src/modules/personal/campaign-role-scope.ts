import type { PersonalCampaign } from "@jobpilot/contracts/personal-campaign";

type Scope = NonNullable<PersonalCampaign["roleScope"]>;
type Evidence = { field: "title" | "company" | "description"; quote: string };
type Decision = {
  decision: "in_scope" | "out_of_scope" | "unknown";
  reasons: string[];
  evidence: Evidence[];
};
type Role = { title: string; company: string; details: unknown };

function description(details: unknown): string {
  if (!details || typeof details !== "object" || !("posting" in details)) return "";
  const posting = details.posting;
  if (!posting || typeof posting !== "object" || !("descriptionText" in posting)) return "";
  return typeof posting.descriptionText === "string" ? posting.descriptionText : "";
}

function match(text: string, pattern: RegExp, field: Evidence["field"]): Evidence | undefined {
  const result = pattern.exec(text);
  return result ? { field, quote: result[0] } : undefined;
}

function firmStatement(text: string, company: string, industry: string): Evidence | undefined {
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:\\bwe\\s+are|${escaped}(?:\\s+(?:Ventures|Investments))?(?:\\s*\\([^)]{1,40}\\))?\\s+is)\\s+[^.!?\\n]{0,120}\\b(?:${industry})\\b[^.!?\\n]{0,80}`,
    "i",
  );
  return match(text, pattern, "description");
}

function investmentUnitEvidence(text: string, company: string): Evidence[] {
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unit = match(
    text,
    new RegExp(
      `\\b${escaped}\\s+Ventures[’']?s?\\s+mission\\s+is\\s+[^.!?\\n]{0,100}\\bventure capital (?:platforms?|fund)\\b`,
      "i",
    ),
    "description",
  );
  const duties = match(
    text,
    /\byou will\s+[^.!?\n]{0,140}\b(?:evaluate|support|make)\s+investments\b/i,
    "description",
  );
  return unit && duties ? [unit, duties] : [];
}

const internshipTitle =
  /\bintern(?:ship)?\b|\bsummer\s+(?:20\d{2}\s+)?(?:associate|analyst|consultant)\b|\b(?:associate|analyst|consultant)\s*[-–—,:]?\s*summer\b/i;
const nonInvestmentTitle =
  /\b(?:account(?:ing|ant)|fund administration|operations|middle office|back office|investor relations|fundraising|compliance|legal|human resources|recruiting|marketing|sales|investment banking|corporate banking|software|IT|information technology|business development|product management)\b/i;

function categoryEvidence(role: Role, category: Scope["categories"][number]): Evidence[] {
  const text = description(role.details);
  if (category === "mbb_consulting") {
    const firm = match(
      role.company.trim(),
      /^(?:McKinsey(?:\s*&\s*Company)?|Bain\s*&\s*Company|Boston Consulting Group|BCG)(?:,?\s+(?:Inc\.?|LLP|LLC))?$/i,
      "company",
    );
    const job = match(
      role.title,
      /\b(?:consultant|consulting|business analyst|summer associate|associate intern(?:ship)?)\b/i,
      "title",
    );
    if (
      /\b(?:software|engineering|recruiting|marketing|accounting|operations|legal|design)\b/i.test(
        role.title,
      )
    )
      return [];
    return firm && job ? [firm, job] : [];
  }
  if (category === "tech_product_management") {
    const job = match(role.title, /\bproduct (?:manage(?:r|ment)|owner)\b/i, "title");
    if (!job) return [];
    const technology =
      match(role.title, /\btechnical product\b/i, "title") ??
      firmStatement(
        text,
        role.company,
        "software|technology|fintech|SaaS|artificial intelligence|AI",
      ) ??
      match(
        text,
        /\b(?:we build|we develop|we provide|our product is)\s+[^.!?\n]{0,80}\b(?:software|SaaS|AI platform|technology platform)\b/i,
        "description",
      );
    return technology ? [job, technology] : [];
  }
  if (nonInvestmentTitle.test(role.title)) return [];
  const job =
    match(
      role.title,
      /\b(?:investment|investing|portfolio|research|trading|quantitative|quant researcher|quant developer|quant trader)\b/i,
      "title",
    ) ??
    match(
      role.title,
      /\b(?:private equity|venture capital|growth equity|hedge fund)\s+(?:summer\s+(?:20\d{2}\s+)?)?(?:analyst|associate|intern(?:ship)?)\b/i,
      "title",
    );
  if (!job) return [];
  const industry =
    "venture capital|private equity|growth equity|hedge fund|asset management|investment management|asset manager|investment manager|alternative investment firm";
  const firm =
    match(
      role.title,
      /\b(?:private equity|venture capital|growth equity|hedge fund)\b/i,
      "title",
    ) ??
    firmStatement(text, role.company, industry) ??
    match(
      text,
      /\b(?:join|work (?:on|within)|part of)\s+(?:our|the)\s+[^.!?\n]{0,60}\b(?:venture capital|private equity|growth equity|hedge fund)\s+(?:investment\s+)?team\b/i,
      "description",
    );
  if (firm) return [job, firm];
  const unit = investmentUnitEvidence(text, role.company);
  return unit.length ? [job, ...unit] : [];
}

export function evaluateCampaignRoleScope(role: Role, scope: Scope): Decision {
  const evidence: Evidence[] = [];
  if (scope.internshipOnly) {
    const notIntern = match(
      role.title,
      /\b(?:permanent|former intern|internship program|(?:intern|internship) (?:coordinator|manager|recruiter)|not an? internship)\b/i,
      "title",
    );
    if (notIntern)
      return {
        decision: "out_of_scope",
        reasons: ["Role is not an internship"],
        evidence: [notIntern],
      };
    const internship = match(role.title, internshipTitle, "title");
    if (!internship) {
      const fullTime = match(
        role.title,
        /\b(?:full[ -]time|permanent|graduate program)\b/i,
        "title",
      );
      return {
        decision: fullTime ? "out_of_scope" : "unknown",
        reasons: [
          fullTime ? "Role is not an internship" : "Posting title does not establish an internship",
        ],
        evidence: fullTime ? [fullTime] : [],
      };
    }
    evidence.push(internship);
  }
  for (const category of scope.categories) {
    const supported = categoryEvidence(role, category);
    if (supported.length)
      return {
        decision: "in_scope",
        reasons: [`Source evidence supports ${category}`],
        evidence: [...evidence, ...supported],
      };
  }
  return {
    decision: "unknown",
    reasons: [
      "Source evidence does not establish a selected target function and employer category",
    ],
    evidence,
  };
}
