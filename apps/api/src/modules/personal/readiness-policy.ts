import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type {
  PersonalReadiness,
  PersonalScreeningAnswer,
  PersonalTerminalReadiness,
} from "@jobpilot/contracts/personal-readiness";
import { z } from "zod";
import { conflict } from "@/common/errors";
import { jurisdictionWorkAuthorization } from "./work-authorization";

const capabilitySchema = z.object({
  structuredTasks: z.boolean(),
  mock: z.boolean(),
  brokerConfigured: z.boolean(),
  codexSupervisorEnabled: z.boolean(),
  providerApproved: z.boolean().optional().default(false),
  providerApprovalScope: z
    .enum(["metadata_only", "applicant_data"])
    .nullable()
    .optional()
    .default(null),
  providerApprovalBlockReason: z.string().max(2000).nullable().optional().default(null),
  codexSupervisorBlockReason: z.string().max(2000).nullable().optional(),
  providers: z.array(
    z.object({
      id: z.enum(["codex", "claude"]),
      installed: z.boolean(),
      version: z.string().max(256).nullable(),
    }),
  ),
});

export async function probeTerminalReadiness(
  token: string | null,
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<PersonalTerminalReadiness> {
  const base = {
    checkedAt: new Date(),
    structuredTasks: false,
    mock: false,
    brokerConfigured: false,
    codexSupervisorEnabled: false,
    providerApproved: false,
    providerApprovalScope: null,
    providerApprovalBlockReason: null,
    providers: [],
    blockReason: null,
  };
  if (!token)
    return {
      ...base,
      status: "needs_auth",
      blockReason: "A scoped local terminal credential is unavailable",
    };
  try {
    const response = await fetcher("http://127.0.0.1:4102/workers/capabilities", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      return {
        ...base,
        status: response.status === 401 ? "needs_auth" : "unavailable",
        blockReason: `Local terminal capability check returned HTTP ${response.status}`,
      };
    const text = await response.text();
    if (text.length > 65536) throw new Error("Oversized capability response");
    const data = capabilitySchema.parse(JSON.parse(text));
    return {
      ...base,
      status: "available",
      structuredTasks: data.structuredTasks,
      mock: data.mock,
      brokerConfigured: data.brokerConfigured,
      codexSupervisorEnabled: data.codexSupervisorEnabled,
      providerApproved: data.providerApproved && data.providerApprovalScope !== null,
      providerApprovalScope: data.providerApproved ? data.providerApprovalScope : null,
      providerApprovalBlockReason: data.providerApprovalBlockReason,
      providers: data.providers,
      blockReason: data.codexSupervisorBlockReason ?? null,
    };
  } catch {
    return {
      ...base,
      status: "unavailable",
      blockReason: "Local terminal capability check failed or exceeded its 3-second timeout",
    };
  }
}

export function missingPersonalSettings(
  settings: PersonalSettings,
): PersonalReadiness["missingSettings"] {
  const fields: [keyof PersonalSettings, string][] = [
    ["mbaEnrolled", "Enrollment must be answered for roles that require a current MBA"],
    ["graduationYear", "Graduation timing must match the posting when required"],
    ["workAuthorization", "Work authorization must be answered for the job's jurisdiction"],
    ["requiresSponsorship", "Sponsorship requirements need an explicit answer"],
    ["citizenship", "Citizenship is only required for postings that explicitly ask"],
    ["availableFrom", "Availability start is unknown"],
    ["availableUntil", "Availability end is unknown"],
    ["yearsExperience", "Years of experience is unknown"],
  ];
  const missing: PersonalReadiness["missingSettings"] = fields
    .filter(([key]) => settings[key] === null)
    .map(([field, reason]) => ({ field, scope: "per_job", reason }));
  if (!settings.workAuthorizationCountries.length)
    missing.push({
      field: "workAuthorizationCountries",
      scope: "per_job",
      reason:
        "Work authorization needs explicitly supplied countries before it can answer a job's question",
    });
  return missing;
}

export function requireSettingsAnswer(
  value: PersonalScreeningAnswer["value"],
  settings: PersonalSettings,
  pointer: string,
  postingLocation: string | null,
) {
  requireExactAnswer(value, exactPointerValue(settings, pointer));
  if (
    (pointer === "/workAuthorization" || pointer === "/requiresSponsorship") &&
    jurisdictionWorkAuthorization(
      postingLocation,
      "",
      // Sponsorship is an exact stored answer, scoped by country, not proof of authorization.
      pointer === "/workAuthorization" ? (settings.workAuthorization ?? undefined) : true,
      settings.workAuthorizationCountries,
    ) === undefined
  )
    throw conflict(
      "Authorization or sponsorship source does not establish the posting's jurisdiction",
    );
}

export function exactPointerValue(value: unknown, pointer: string): unknown {
  let current: unknown = value;
  for (const part of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (
      !current ||
      typeof current !== "object" ||
      ["__proto__", "constructor", "prototype"].includes(part) ||
      !Object.hasOwn(current, part)
    )
      throw conflict("Source pointer does not reference a known stored value");
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function requireExactAnswer(value: PersonalScreeningAnswer["value"], source: unknown) {
  let exact: boolean;
  if (Array.isArray(value))
    exact =
      Array.isArray(source) &&
      source.every((item) => typeof item === "string") &&
      JSON.stringify(value) === JSON.stringify(source);
  else if (typeof value === "boolean") exact = source === value;
  else exact = ["string", "boolean", "number"].includes(typeof source) && String(source) === value;
  if (!exact)
    throw conflict(
      "Answer must exactly match the known source value; use explicit user confirmation for a different wording",
    );
}

interface ScreeningQuestion {
  fieldName: string;
  label: string;
  multiple?: boolean;
  options?: { value: string; label: string }[];
}

export function answeredScreeningFields(
  answers: PersonalScreeningAnswer[],
  questions: ScreeningQuestion[],
) {
  const answered = new Set<string>();
  const label = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  for (const question of questions) {
    const matching = answers.filter((answer) => {
      if (answer.fieldName) return answer.fieldName === question.fieldName;
      return (
        !!answer.label &&
        label(answer.label) === label(question.label) &&
        questions.filter((other) => label(other.label) === label(question.label)).length === 1
      );
    });
    if (
      matching.length !== 1 ||
      questions.filter((other) => other.fieldName === question.fieldName).length !== 1
    )
      continue;
    const value = matching[0]!.value;
    if (Array.isArray(value)) {
      if (
        !question.multiple ||
        !question.options ||
        value.some(
          (item) => question.options!.filter((option) => option.value === item).length !== 1,
        )
      )
        throw conflict(
          "Selection answers must match the complete observed multiselect option inventory",
        );
      if (value.length) answered.add(question.fieldName);
    } else if (question.multiple)
      throw conflict("Observed multiselect requires an explicit answer set");
    else if (typeof value === "boolean" || value.trim()) answered.add(question.fieldName);
  }
  return answered;
}
