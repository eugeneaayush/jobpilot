import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type { PersonalScreeningSuggestion } from "@jobpilot/contracts/personal-readiness";
import { manifestHash } from "./persistence-policy";
import { exactPointerValue, requireSettingsAnswer } from "./readiness-policy";

type Question = { fieldName: string; label: string; type: string; required: boolean };
const normalized = (value: string) =>
  value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
function category(label: string): PersonalScreeningSuggestion["category"] {
  if (/\b(?:consent|certify|agree|acknowledge|attest|terms|privacy policy)\b/.test(label))
    return "consent";
  if (/\b(?:gender|ethnicity|race|disability|veteran|demographic|sexual orientation)\b/.test(label))
    return "voluntary_demographic";
  if (/\bsponsor(?:ship|ed)?\b/.test(label)) return "sponsorship";
  if (/\b(?:authori[sz](?:ed|ation)|right) to work\b|\bwork authori[sz]ation\b/.test(label))
    return "authorization";
  if (/\b(?:salary|compensation|pay|hourly rate)\b/.test(label)) return "compensation";
  if (/\brelocat(?:e|ion|ing)\b/.test(label)) return "relocation";
  if (/\b(?:available|availability|start date|start work)\b/.test(label)) return "availability";
  if (/\byears?\b.*\bexperience\b|\bexperience\b.*\byears?\b/.test(label)) {
    if (
      /^(?:how many )?(?:total )?years? of (?:total |professional |work |professional work )?experience(?: do you have)?[?:.]?$/.test(
        label,
      )
    )
      return "total_experience";
    return "skill_experience";
  }
  return "unknown";
}

export function screeningSuggestions(
  questions: Question[],
  settings: PersonalSettings,
  postingLocation: string | null,
): PersonalScreeningSuggestion[] {
  const settingsHash = manifestHash(settings);
  return questions.map((question, index) => {
    const label = normalized(question.label || question.fieldName);
    const kind = category(label);
    const result: PersonalScreeningSuggestion = {
      fieldName: question.fieldName,
      category: kind,
      answer: null,
      reason: "An explicit answer is required; no matching source is established",
    };
    if (kind === "consent") {
      result.reason = "This declaration requires explicit confirmation for this application";
      return result;
    }
    if (kind === "voluntary_demographic") {
      result.reason =
        settings.screeningDefaults?.voluntaryDemographics === "decline"
          ? "Decline preference is saved; confirm the exact offered decline option"
          : "No voluntary demographic preference was supplied";
      return result;
    }
    let pointer: string | undefined;
    if (kind === "authorization" && !/\b(?:not|without|sponsor|future|ever)\b/.test(label))
      pointer = "/workAuthorization";
    if (
      kind === "sponsorship" &&
      /\b(?:require|need)\b/.test(label) &&
      !/\b(?:not|without|no sponsorship)\b/.test(label)
    )
      pointer = "/requiresSponsorship";
    if (kind === "total_experience") pointer = "/yearsExperience";
    if (kind === "skill_experience") {
      const skills = settings.screeningDefaults?.skillExperience ?? [];
      const requested =
        /^(?:how many )?years?(?: of)? experience (?:do you have )?(?:with|in|using) (.+?)(?: do you have)?[?.]?$/.exec(
          label,
        )?.[1] ??
        /^(?:how many )?years? of (.+?) experience(?: do you have)?[?.]?$/.exec(label)?.[1];
      const matches = skills
        .map((item, skillIndex) => ({ skill: normalized(item.skill), skillIndex }))
        .filter(({ skill }) => requested !== undefined && skill === requested);
      if (matches.length === 1)
        pointer = `/screeningDefaults/skillExperience/${matches[0]!.skillIndex}/years`;
      result.reason =
        "Skill-specific experience must be explicitly supplied; total career years are not a substitute";
    }
    if (
      kind === "relocation" &&
      /\b(?:willing|able|open)\b/.test(label) &&
      !/\b(?:not|without)\b/.test(label)
    )
      pointer = "/screeningDefaults/willingToRelocate";
    if (
      kind === "availability" &&
      /\b(?:date|when)\b/.test(label) &&
      !/\b(?:end|until|notice period|hours)\b/.test(label)
    )
      pointer = "/availableFrom";
    if (kind === "compensation") {
      const desired = settings.screeningDefaults?.desiredCompensation;
      const periods = [
        { value: "year", pattern: /\b(?:annual|yearly|per year|annum)\b/ },
        { value: "hour", pattern: /\b(?:hourly|per hour)\b/ },
      ].filter((item) => item.pattern.test(label));
      const currencies = [
        { value: "USD", pattern: /\b(?:usd|us dollars?)\b/ },
        { value: "EUR", pattern: /\beur\b/ },
        { value: "GBP", pattern: /\bgbp\b/ },
      ].filter((item) => item.pattern.test(label));
      const period = periods.length === 1 ? periods[0]!.value : null;
      const currency = currencies.length === 1 ? currencies[0]!.value : null;
      if (
        desired &&
        desired.period === period &&
        desired.currency === currency &&
        /\b(?:desired|expect|expectation|expected|target)\b/.test(label) &&
        !/\b(?:current|previous|history)\b/.test(label)
      )
        pointer = "/screeningDefaults/desiredCompensation/amount";
      result.reason =
        "Desired compensation requires explicit matching currency and period; minimum compensation is not a salary expectation";
    }
    if (!pointer) return result;
    let value: unknown;
    try {
      value = exactPointerValue(settings, pointer);
      if (typeof value === "number") value = String(value);
      if (typeof value !== "string" && typeof value !== "boolean") return result;
      requireSettingsAnswer(value, settings, pointer, postingLocation);
    } catch {
      return result;
    }
    result.answer = {
      key: `suggested-${index}`,
      fieldName: question.fieldName,
      label: question.label,
      value: value as string | boolean,
      source: { kind: "settings", pointer, settingsHash },
    };
    result.reason =
      "Exact saved value and source; confirm it matches the employer's offered control before saving";
    return result;
  });
}
