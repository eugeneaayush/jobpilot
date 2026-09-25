import {
  type PersonalDashboard,
  type PersonalRecordDto,
  personalTrackSchema,
} from "@jobpilot/contracts/personal";
import type { ChipProps } from "@mui/material";

/** The contract exports DTO types only; track/state derive off the record. */
export type PersonalTrack = PersonalRecordDto["track"];
export type PersonalState = PersonalRecordDto["state"];
export type PersonalSeniority = NonNullable<PersonalRecordDto["seniority"]>;

export const TRACK_LABEL: Record<PersonalTrack, string> = {
  mba_internship: "MBA internship",
  post_mba_fulltime: "Post-MBA full-time",
  general_professional: "General professional",
};

export const STATE_LABEL: Record<PersonalState, string> = {
  discovered: "Discovered",
  eligible: "Eligible",
  prepared: "Prepared",
  applying: "Applying",
  submitted: "Submitted",
  blocked: "Blocked",
  failed: "Failed",
  submission_uncertain: "Submission uncertain",
};

export const STATE_COLOR: Record<PersonalState, ChipProps["color"]> = {
  discovered: "default",
  eligible: "info",
  prepared: "primary",
  applying: "info",
  submitted: "success",
  blocked: "warning",
  failed: "error",
  submission_uncertain: "warning",
};

export type PersonalSourceStatus = PersonalDashboard["sources"][number]["status"];

export const SOURCE_STATUS_LABEL: Record<PersonalSourceStatus, string> = {
  complete: "Complete",
  partial: "Partial",
  failed: "Failed",
  blocked: "Blocked",
};

export const SOURCE_STATUS_COLOR: Record<PersonalSourceStatus, ChipProps["color"]> = {
  complete: "success",
  partial: "warning",
  failed: "error",
  blocked: "default",
};

export type PersonalEligibilityDecision = PersonalRecordDto["eligibility"]["decision"];

export const SENIORITY_LABEL: Record<PersonalSeniority["classification"], string> = {
  graduate_recruiting: "Graduate recruiting",
  experienced_professional: "Experienced professional",
  undergraduate_entry: "Undergraduate entry",
  unresolved: "Seniority unresolved",
};

export const SENIORITY_COLOR: Record<PersonalSeniority["classification"], ChipProps["color"]> = {
  graduate_recruiting: "success",
  experienced_professional: "success",
  undergraduate_entry: "error",
  unresolved: "warning",
};

/** Prepare actions are gated by the API's authoritative classification, never UI guesswork. */
export function prepareBlockedReason(seniority: PersonalSeniority | undefined): string | null {
  if (!seniority)
    return "Seniority not yet classified — the posting is held until the backend classifies it.";
  if (seniority.classification === "undergraduate_entry")
    return "Undergraduate entry is excluded from this plan.";
  if (seniority.classification === "unresolved")
    return "Seniority unresolved — graduate or experienced-professional evidence is required before preparing.";
  return null;
}

export const ELIGIBILITY_LABEL: Record<PersonalEligibilityDecision, string> = {
  eligible: "Eligible",
  ineligible: "Ineligible",
  unknown: "Unknown",
};

export const ELIGIBILITY_COLOR: Record<PersonalEligibilityDecision, ChipProps["color"]> = {
  eligible: "success",
  ineligible: "error",
  unknown: "default",
};

const TRACKS = personalTrackSchema.options as readonly string[];

/** Narrows a `?track=` param to a real track before it reaches the query. */
export function isPersonalTrack(value: string | null): value is PersonalTrack {
  return value !== null && TRACKS.includes(value);
}
