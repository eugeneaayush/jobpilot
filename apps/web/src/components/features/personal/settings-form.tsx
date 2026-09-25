"use client";

import type { ReactElement } from "react";
import type { PersonalSettings } from "@jobpilot/contracts/personal";
import { Grid, LinearProgress, Stack, Typography } from "@mui/material";
import { z } from "zod/v4";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueries, personalQueryKeys } from "@/api/personal";
import { useAppForm } from "@/components/ui/form/tanstack";
import { SectionCard } from "@/components/ui/layout";

/** "" means "not answered" — the API keeps the fact null rather than guessing. */
const triState = z.enum(["", "yes", "no"]);
const periodState = z.enum(["", "year", "hour"]);

const settingsFormSchema = z.object({
  mbaEnrolled: triState,
  graduationYear: z.union([z.number().int().min(2000).max(2100), z.null()]),
  availableFrom: z.string(),
  availableUntil: z.string(),
  locationsText: z.string(),
  targetFunctionsText: z.string(),
  exclusionsText: z.string(),
  minimumCompensation: z.union([z.number().nonnegative(), z.null()]),
  // Currency/period are stated, never inferred: no USD/year default exists anywhere.
  // "" is the form's unset state — the mapping sends null, so it must validate.
  compensationCurrency: z.union([
    z.string().regex(/^[A-Z]{3}$/, "Three uppercase letters."),
    z.literal(""),
    z.null(),
  ]),
  compensationPeriod: periodState,
  workAuthorization: triState,
  requiresSponsorship: triState,
  // ISO 3166-1 alpha-2 only; the field uppercases as you type.
  authorizationCountriesText: z
    .string()
    .refine(
      (text) => splitList(text).every((code) => /^[A-Z]{2}$/.test(code)),
      "Two-letter country codes, e.g. US, DE.",
    ),
  availabilityNotes: z.string().max(2000, "Keep notes under 2000 characters."),
  citizenship: z.string(),
  yearsExperience: z.union([z.number().nonnegative(), z.null()]),
  fitThreshold: z.number().min(0).max(100),
  dailyCap: z.number().int().nonnegative(),
  maxApplications: z.number().int().nonnegative(),
  timezone: z.string().min(1),
});

type SettingsFormValues = z.infer<typeof settingsFormSchema>;

const UNKNOWN_HINT = "Leave empty to keep this unknown.";
const LIST_HINT = "Comma-separated. Empty means no preference yet.";

const TRI_STATE_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

function toTriState(value: boolean | null): "" | "yes" | "no" {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "";
}

function fromTriState(value: "" | "yes" | "no"): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toFormValues(settings: PersonalSettings): SettingsFormValues {
  return {
    mbaEnrolled: toTriState(settings.mbaEnrolled),
    graduationYear: settings.graduationYear,
    availableFrom: settings.availableFrom ?? "",
    availableUntil: settings.availableUntil ?? "",
    locationsText: settings.locations.join(", "),
    targetFunctionsText: settings.targetFunctions.join(", "),
    exclusionsText: settings.exclusions.join(", "),
    minimumCompensation: settings.minimumCompensation,
    compensationCurrency: settings.compensationCurrency ?? "",
    compensationPeriod: settings.compensationPeriod ?? "",
    workAuthorization: toTriState(settings.workAuthorization),
    requiresSponsorship: toTriState(settings.requiresSponsorship),
    authorizationCountriesText: settings.workAuthorizationCountries.join(", "),
    availabilityNotes: settings.availabilityNotes ?? "",
    citizenship: settings.citizenship ?? "",
    yearsExperience: settings.yearsExperience,
    fitThreshold: settings.fitThreshold,
    dailyCap: settings.dailyCap,
    maxApplications: settings.maxApplications,
    timezone: settings.timezone,
  };
}

function toSettings(values: SettingsFormValues): PersonalSettings {
  return {
    mbaEnrolled: fromTriState(values.mbaEnrolled),
    graduationYear: values.graduationYear,
    availableFrom: values.availableFrom.trim() || null,
    availableUntil: values.availableUntil.trim() || null,
    locations: splitList(values.locationsText),
    targetFunctions: splitList(values.targetFunctionsText),
    exclusions: splitList(values.exclusionsText),
    minimumCompensation: values.minimumCompensation,
    compensationCurrency: (values.compensationCurrency ?? "").trim() || null,
    compensationPeriod: values.compensationPeriod === "" ? null : values.compensationPeriod,
    workAuthorization: fromTriState(values.workAuthorization),
    requiresSponsorship: fromTriState(values.requiresSponsorship),
    workAuthorizationCountries: splitList(values.authorizationCountriesText).map((code) =>
      code.toUpperCase(),
    ),
    availabilityNotes: values.availabilityNotes.trim() || null,
    citizenship: values.citizenship.trim() || null,
    yearsExperience: values.yearsExperience,
    fitThreshold: values.fitThreshold,
    dailyCap: values.dailyCap,
    maxApplications: values.maxApplications,
    timezone: values.timezone.trim(),
  };
}

/**
 * Personal facts and run limits. Nullable by contract: an unanswered fact stays null on the
 * server, so eligibility can report "unknown" instead of assuming.
 */
export function SettingsForm(): ReactElement {
  const settings = useApiQuery(personalQueries.settings());

  const save = useApiMutation<PersonalSettings, PersonalSettings>(
    (body) => api.personal.settings.put(body),
    {
      successMessage: "Settings saved",
      invalidate: [personalQueryKeys.all],
    },
  );

  const form = useAppForm({
    defaultValues: settings.data ? toFormValues(settings.data) : FALLBACK_VALUES,
    validators: { onSubmit: settingsFormSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(toSettings(value));
    },
  });

  if (settings.isLoading) {
    return <LinearProgress />;
  }

  // A failed read must not render a blank form: saving it would erase known facts.
  if (!settings.data) {
    return (
      <SectionCard title="Settings">
        <Typography variant="body2Muted" sx={{ py: 2, textAlign: "center" }}>
          Couldn&apos;t load your settings.
        </Typography>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Settings"
      description="Personal facts and run limits. Anything left blank stays unknown — nothing is inferred."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <Stack spacing={2.5}>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <form.AppField name="mbaEnrolled">
                {(field) => (
                  <field.Select
                    label="Currently enrolled in an MBA"
                    optional
                    emptyLabel="Unknown"
                    items={TRI_STATE_ITEMS}
                    helperText="Drives the MBA internship vs full-time tracks."
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <form.AppField name="graduationYear">
                {(field) => (
                  <field.TextField
                    label="Graduation year"
                    type="number"
                    helperText={UNKNOWN_HINT}
                    slotProps={{ htmlInput: { min: 2000, max: 2100, step: 1 } }}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <form.AppField name="availableFrom">
                {(field) => (
                  <field.TextField label="Available from" type="date" helperText={UNKNOWN_HINT} />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <form.AppField name="availableUntil">
                {(field) => (
                  <field.TextField label="Available until" type="date" helperText={UNKNOWN_HINT} />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <form.AppField name="yearsExperience">
                {(field) => (
                  <field.TextField
                    label="Years of experience"
                    type="number"
                    helperText={UNKNOWN_HINT}
                    slotProps={{ htmlInput: { min: 0, step: 1 } }}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, md: 9 }}>
              <form.AppField name="availabilityNotes">
                {(field) => (
                  <field.TextField
                    label="Availability notes"
                    multiline
                    minRows={2}
                    helperText="Context about your availability — it must not state exact dates; use the date fields for those."
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="locationsText">
                {(field) => <field.TextField label="Locations" helperText={LIST_HINT} />}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="targetFunctionsText">
                {(field) => <field.TextField label="Target functions" helperText={LIST_HINT} />}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="exclusionsText">
                {(field) => <field.TextField label="Exclusions" helperText={LIST_HINT} />}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="workAuthorization">
                {(field) => (
                  <field.Select
                    label="Authorized to work"
                    optional
                    emptyLabel="Unknown"
                    items={TRI_STATE_ITEMS}
                    helperText="Unknown is a valid answer."
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="authorizationCountriesText">
                {(field) => (
                  <field.TextField
                    label="Work-authorized countries"
                    helperText="Your authorization applies only to the countries listed here — empty means unknown."
                    // ISO codes are uppercase by definition; typing enforces it.
                    transform={(value) => value.toUpperCase()}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="requiresSponsorship">
                {(field) => (
                  <field.Select
                    label="Requires sponsorship"
                    optional
                    emptyLabel="Unknown"
                    items={TRI_STATE_ITEMS}
                    helperText="Unknown is a valid answer."
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="citizenship">
                {(field) => <field.TextField label="Citizenship" helperText={UNKNOWN_HINT} />}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="minimumCompensation">
                {(field) => (
                  <field.TextField
                    label="Minimum compensation"
                    type="number"
                    helperText={UNKNOWN_HINT}
                    slotProps={{ htmlInput: { min: 0 } }}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="compensationCurrency">
                {(field) => (
                  <field.TextField
                    label="Currency"
                    helperText="ISO 4217, e.g. EUR. Never assumed."
                    // ISO 4217 codes are uppercase by definition; typing enforces it.
                    transform={(value) => value.toUpperCase()}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="compensationPeriod">
                {(field) => (
                  <field.Select
                    label="Compensation period"
                    optional
                    emptyLabel="Unknown"
                    items={[
                      { value: "year", label: "Per year" },
                      { value: "hour", label: "Per hour" },
                    ]}
                    helperText="Unknown is a valid answer."
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="fitThreshold">
                {(field) => (
                  <field.TextField
                    label="Fit threshold"
                    type="number"
                    helperText="Records below this fit score stay undiscovered-tier."
                    slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="dailyCap">
                {(field) => (
                  <field.TextField
                    label="Daily cap"
                    type="number"
                    helperText="0 disables runs."
                    slotProps={{ htmlInput: { min: 0, step: 1 } }}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="maxApplications">
                {(field) => (
                  <field.TextField
                    label="Max applications"
                    type="number"
                    helperText="0 means no cap."
                    slotProps={{ htmlInput: { min: 0, step: 1 } }}
                  />
                )}
              </form.AppField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <form.AppField name="timezone">
                {(field) => (
                  <field.TextField
                    label="Timezone"
                    helperText="IANA name, e.g. America/New_York."
                  />
                )}
              </form.AppField>
            </Grid>
          </Grid>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 1 }}
          >
            <Typography variant="captionMuted">
              Blank facts stay unknown — eligibility will say so rather than assume.
            </Typography>
            <form.AppForm>
              <form.SubmitButton disabled={save.isPending}>Save</form.SubmitButton>
            </form.AppForm>
          </Stack>
        </Stack>
      </form>
    </SectionCard>
  );
}

/** Initializer while the first fetch is in flight; the real values overlay once loaded. */
const FALLBACK_VALUES: SettingsFormValues = {
  mbaEnrolled: "",
  compensationCurrency: "",
  compensationPeriod: "",
  graduationYear: null,
  availableFrom: "",
  availableUntil: "",
  locationsText: "",
  targetFunctionsText: "",
  exclusionsText: "",
  minimumCompensation: null,
  workAuthorization: "",
  authorizationCountriesText: "",
  availabilityNotes: "",
  requiresSponsorship: "",
  citizenship: "",
  yearsExperience: null,
  fitThreshold: 70,
  dailyCap: 0,
  maxApplications: 0,
  timezone: "America/New_York",
};
