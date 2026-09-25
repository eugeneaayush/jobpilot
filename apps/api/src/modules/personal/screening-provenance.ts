import type { PersonalSettings } from "@jobpilot/contracts/personal";
import {
  type PersonalScreeningAnswer,
  personalScreeningSnapshotSchema,
} from "@jobpilot/contracts/personal-readiness";
import { conflict } from "@/common/errors";
import type { PersonalRecord, PersonalResumeEvidence } from "@/generated/prisma/client";
import { postingContentHash } from "./attachments-policy";
import { preparedCampaignAnswers } from "./campaign-policy";
import { manifestHash } from "./persistence-policy";
import { exactPointerValue, requireExactAnswer, requireSettingsAnswer } from "./readiness-policy";
import { objectValue, textValue } from "./runtime";

type Evidence = Pick<PersonalResumeEvidence, "id" | "sourceHash" | "details">;
type RecordContext = Pick<PersonalRecord, "id" | "identity" | "details">;

// Original audit leaves remain immutable; resolved printable facts control present-tense claims.
export function currentResumeCitationValue(evidence: Evidence, pointer: string): unknown {
  const details = objectValue(evidence.details);
  const resolution = objectValue(details.resolution);
  if (pointer.startsWith("/resolved/")) {
    if (resolution.document === undefined)
      throw conflict("Current resolved resume document is unavailable");
    return exactPointerValue(resolution.document, pointer.slice("/resolved".length));
  }
  const leaves = objectValue(details.manifest).leaves;
  const matching = Array.isArray(leaves)
    ? leaves.map(objectValue).filter((leaf) => leaf.pointer === pointer)
    : [];
  if (matching.length !== 1) throw conflict("Resume pointer must identify one current source leaf");
  const value = matching[0]?.value;
  if (resolution.document !== undefined) {
    const pending: unknown[] = [resolution.document];
    let retained = false;
    while (pending.length) {
      const item = pending.pop();
      if (Array.isArray(item)) pending.push(...item);
      else if (item && typeof item === "object") pending.push(...Object.values(item));
      else if (item === value && item !== null && item !== undefined) {
        retained = true;
        break;
      }
    }
    if (!retained)
      throw conflict(
        "Resume citation was overridden or omitted from the current resolved document",
      );
  }
  return value;
}

const demographicDeclineLabels = new Set([
  "I don't wish to answer",
  "I do not wish to answer",
  "I do not want to answer",
  "I prefer not to answer",
  "Prefer not to answer",
  "Decline to answer",
  "I decline to answer",
  "I don't wish to self-identify",
  "I do not wish to self-identify",
  "I prefer not to self-identify",
  "Prefer not to self-identify",
  "Decline to self-identify",
  "I choose not to disclose",
  "I do not wish to disclose",
  "I prefer not to disclose",
  "Prefer not to disclose",
]);

const usStates: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};
const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
function usLocationLabel(value: string): string | undefined {
  const matched = /^([A-Za-z]+(?:[ .'-][A-Za-z]+)*), ([A-Z]{2})$/.exec(value);
  if (!matched || !usStates[matched[2]!]) return undefined;
  return `${matched[1]}, ${usStates[matched[2]!]}, United States`;
}
function educationDate(value: string) {
  const parts =
    /^(?:([A-Z][a-z]+) ((?:19|20|21)[0-9]{2}) [–-] )?([A-Z][a-z]+) ((?:19|20|21)[0-9]{2})$/.exec(
      value,
    );
  if (!parts) return undefined;
  const monthIndex = (name: string) =>
    months.findIndex((month) => month === name || month.slice(0, 3) === name);
  const endMonth = monthIndex(parts[3]!);
  if (endMonth < 0) return undefined;
  if (parts[1]) {
    const startMonth = monthIndex(parts[1]);
    if (startMonth < 0 || Number(parts[2]) * 12 + startMonth > Number(parts[4]) * 12 + endMonth)
      return undefined;
  }
  return { month: months[endMonth]!, year: parts[4]! };
}
function requireNormalizedResumeAnswer(answer: PersonalScreeningAnswer, evidence: Evidence) {
  const source = answer.source;
  if (source.kind !== "resume_normalized") throw conflict("Invalid resume normalization source");
  const value = currentResumeCitationValue(evidence, source.pointer);
  if (typeof value !== "string" || typeof answer.value !== "string")
    throw conflict("Resume normalization requires exact textual source values");
  const sourcePath = source.pointer.replace(/^\/resolved/, "");
  let expected: string | undefined;
  if (
    source.transformation === "mba_degree_without_candidate" &&
    answer.fieldName === "degree" &&
    /^\/education\/(?:0|[1-9][0-9]*)\/(?:degree|studyType)$/.test(sourcePath) &&
    value === "Master of Business Administration Candidate"
  )
    expected =
      answer.value === "Master of Business Administration (M.B.A.)"
        ? "Master of Business Administration (M.B.A.)"
        : "Master of Business Administration";
  if (
    source.transformation === "cbs_parent_university" &&
    answer.fieldName === "school_name" &&
    /^\/education\/(?:0|[1-9][0-9]*)\/(?:school|institution)$/.test(sourcePath) &&
    value === "Columbia Business School"
  )
    expected = "Columbia University";
  if (
    ["education_end_month", "education_end_year"].includes(source.transformation) &&
    /^\/education\/(?:0|[1-9][0-9]*)\/(?:start|end)$/.test(sourcePath)
  ) {
    const date = educationDate(value);
    if (source.transformation === "education_end_month" && answer.fieldName === "end_month")
      expected = date?.month;
    if (source.transformation === "education_end_year" && answer.fieldName === "end_year")
      expected = date?.year;
    // A lone start date cannot establish a graduation date.
    if (sourcePath.endsWith("/start") && !/ [–-] /.test(value)) expected = undefined;
  }
  if (
    source.transformation === "us_city_state_label" &&
    answer.fieldName === "location" &&
    sourcePath === "/basics/location"
  )
    expected = usLocationLabel(value);
  if (
    source.transformation === "phone_country_label" &&
    answer.fieldName === "country" &&
    sourcePath === "/basics/phone" &&
    /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/.test(value) &&
    source.countryPointer &&
    /^\/(?:resolved\/)?basics\/(?:location|country)$/.test(source.countryPointer)
  ) {
    const country = currentResumeCitationValue(evidence, source.countryPointer);
    if (
      typeof country === "string" &&
      (["US", "USA", "United States", "United States of America"].includes(country) ||
        usLocationLabel(country))
    )
      expected = "United States +1";
  }
  if (expected === undefined || answer.value !== expected)
    throw conflict(
      "Normalized answer must match an allowed field and deterministic current resume transformation",
    );
}

export function validateScreeningAnswerSources(
  answers: PersonalScreeningAnswer[],
  settings: PersonalSettings,
  evidence: Evidence | null,
  postingLocation: string | null,
) {
  for (const answer of answers) {
    const source = answer.source;
    if (source.kind === "explicit_user") continue;
    if (source.kind === "delegated_preference") {
      // This records a privacy choice; the live broker must still verify the exact decline option.
      if (
        source.preference !== "decline_voluntary_demographics" ||
        !/^demographic_[1-9][0-9]*$/.test(answer.fieldName ?? "") ||
        typeof answer.value !== "string" ||
        !demographicDeclineLabels.has(answer.value)
      )
        throw conflict(
          "Delegated demographic preferences allow only explicit decline labels on demographic fields",
        );
      continue;
    }
    if (source.kind === "settings") {
      if (source.settingsHash !== manifestHash(settings))
        throw conflict(
          "Screening answer settings changed; review the current source before using this answer",
        );
      requireSettingsAnswer(answer.value, settings, source.pointer, postingLocation);
      continue;
    }
    if (!evidence || source.evidenceId !== evidence.id || source.sourceHash !== evidence.sourceHash)
      throw conflict(
        "Screening answer cites superseded resume evidence; review the current source before using this answer",
      );
    if (source.kind === "resume_normalized") {
      requireNormalizedResumeAnswer(answer, evidence);
      continue;
    }
    requireExactAnswer(answer.value, currentResumeCitationValue(evidence, source.pointer));
  }
}

export function validateScreeningSnapshot(
  record: RecordContext,
  settings: PersonalSettings,
  evidence: Evidence | null,
) {
  const value = objectValue(record.details).screeningAnswers;
  if (value === undefined || value === null) return null;
  const parsed = personalScreeningSnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw conflict("Saved screening answer provenance is invalid; review the answers");
  const snapshot = parsed.data;
  const { snapshotHash, ...content } = snapshot;
  if (
    snapshotHash !== manifestHash(content) ||
    snapshot.recordId !== record.id ||
    snapshot.identity !== record.identity ||
    snapshot.postingContentHash !== postingContentHash(record) ||
    snapshot.settingsHash !== manifestHash(settings)
  )
    throw conflict("Screening answer snapshot differs from the current record or source context");
  if (
    snapshot.answers.length > 100 ||
    new Set(snapshot.answers.map((answer) => answer.key)).size !== snapshot.answers.length
  )
    throw conflict("Screening answer keys must be unique and bounded");
  validateScreeningAnswerSources(
    snapshot.answers,
    settings,
    evidence,
    textValue(objectValue(objectValue(record.details).posting).location) || null,
  );
  return snapshot;
}

export function validateManifestScreeningSources(
  manifest: unknown,
  record: RecordContext,
  settings: PersonalSettings,
  evidence: Evidence | null,
) {
  const snapshot = validateScreeningSnapshot(record, settings, evidence);
  const frozen = objectValue(manifest);
  if (
    manifestHash(frozen.screeningAnswerSnapshot ?? null) !== manifestHash(snapshot) ||
    (frozen.screeningAnswerSnapshotHash ?? null) !== (snapshot?.snapshotHash ?? null)
  )
    throw conflict("Frozen screening answer provenance differs from the saved source snapshot");
  const answers = preparedCampaignAnswers(frozen.answers ?? []);
  if (manifestHash(answers) !== manifestHash(preparedCampaignAnswers(snapshot?.answers ?? [])))
    throw conflict("Frozen answers differ from their exact source citations");
}
