"use client";

import type { ReactElement } from "react";
import { Alert, Chip, Stack, Typography } from "@mui/material";
import { SectionCard } from "@/components/ui/layout";

type SeniorityClassification =
  | "graduate_recruiting"
  | "experienced_professional"
  | "undergraduate_entry"
  | "unresolved";

interface SeniorityEvidence {
  /** Which part of the posting the quote was taken from. */
  field: "title" | "description";
  quote: string;
}

interface SeniorityAssessmentProps {
  classification: SeniorityClassification;
  reasons: string[];
  evidence: SeniorityEvidence[];
}

const CLASSIFICATION_LABEL: Record<SeniorityClassification, string> = {
  graduate_recruiting: "Graduate recruiting",
  experienced_professional: "Experienced professional",
  undergraduate_entry: "Undergraduate entry",
  unresolved: "Needs evidence",
};

const CLASSIFICATION_COLOR: Record<SeniorityClassification, "success" | "error" | "warning"> = {
  graduate_recruiting: "success",
  experienced_professional: "success",
  undergraduate_entry: "error",
  unresolved: "warning",
};

/**
 * Seniority verdict for one posting. Graduate and experienced roles are the accepted tracks;
 * undergraduate entry is excluded outright; unresolved means there is not yet affirmative
 * evidence for a graduate level — it is never treated as eligible by default.
 */
export function SeniorityAssessment(props: SeniorityAssessmentProps): ReactElement {
  const { classification, reasons, evidence } = props;
  const accepted =
    classification === "graduate_recruiting" || classification === "experienced_professional";
  const excluded = classification === "undergraduate_entry";
  const severity = accepted ? "success" : excluded ? "error" : "warning";
  const verdict = accepted
    ? `Accepted — ${CLASSIFICATION_LABEL[classification]}`
    : excluded
      ? "Excluded — undergraduate entry. This plan does not pursue entry-level undergraduate roles."
      : "Needs evidence — no affirmative graduate-level evidence yet. Unknown seniority is not eligible.";

  return (
    <SectionCard
      title="Seniority"
      description="Graduate-level and experienced roles only. Undergraduate entry is excluded; mixed programs need affirmative graduate-level evidence."
    >
      <Stack spacing={2}>
        <Alert severity={severity}>{verdict}</Alert>

        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
          <Chip
            color={CLASSIFICATION_COLOR[classification]}
            variant="outlined"
            label={CLASSIFICATION_LABEL[classification]}
          />
          {reasons.map((reason) => (
            <Chip key={reason} size="small" variant="outlined" label={reason} />
          ))}
        </Stack>

        <Stack spacing={1}>
          <Typography variant="overlineMuted">Source quotes</Typography>
          {evidence.length === 0 ? (
            <Typography variant="body2Muted">No source evidence recorded.</Typography>
          ) : (
            evidence.map((item) => (
              <Stack
                key={`${item.field}:${item.quote}`}
                spacing={0.5}
                sx={(theme) => ({
                  border: 1,
                  borderColor: theme.palette.line.border,
                  borderRadius: theme.radii.md,
                  p: 1.5,
                })}
              >
                <Typography variant="captionMuted">{item.field}</Typography>
                <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
                  “{item.quote}”
                </Typography>
              </Stack>
            ))
          )}
        </Stack>
      </Stack>
    </SectionCard>
  );
}
