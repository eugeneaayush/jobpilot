"use client";

import { type ReactElement, useState } from "react";
import type {
  PersonalCampaign,
  PersonalCampaignCreateInput,
} from "@jobpilot/contracts/personal-campaign";
import { Launch, StopCircle } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useSelector } from "@tanstack/react-form";
import { z } from "zod/v4";
import { api } from "@/api/client";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueries, personalQueryKeys } from "@/api/personal";
import { EmptyState } from "@/components/ui/data";
import { ColorChip, LabelValue, RelativeTime } from "@/components/ui/display";
import { useAppForm } from "@/components/ui/form/tanstack";
import { SectionCard } from "@/components/ui/layout";
import { TRACK_LABEL } from "./personal-labels";

const MODE_LABEL = { offline: "Offline", submit: "Submit" } as const;

const TRACK_FIELDS = [
  { name: "mbaInternship", track: "mba_internship" },
  { name: "postMbaFulltime", track: "post_mba_fulltime" },
  { name: "generalProfessional", track: "general_professional" },
] as const;

type ScopeCategory = NonNullable<PersonalCampaign["roleScope"]>["categories"][number];

const SCOPE_CATEGORY_FIELDS = [
  { name: "scopeTechProductManagement", category: "tech_product_management" },
  { name: "scopeMbbConsulting", category: "mbb_consulting" },
  { name: "scopeBuySideInvesting", category: "buy_side_investing" },
] as const satisfies ReadonlyArray<{ name: string; category: ScopeCategory }>;

const CATEGORY_LABEL: Record<ScopeCategory, string> = {
  tech_product_management: "Tech product management",
  mbb_consulting: "MBB consulting",
  buy_side_investing: "Buy-side investing",
};

/** One line for the pre-launch summary: level restriction plus the named categories. */
function scopeLine(roleScope: NonNullable<PersonalCampaign["roleScope"]>): string {
  const level = roleScope.internshipOnly ? "Internships only" : "Any level";
  return `${level} · ${roleScope.categories.map((c) => CATEGORY_LABEL[c]).join(", ")}`;
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Mirrors personalCampaignCreateSchema with field-level messages.
const campaignFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name the campaign.").max(200),
    mode: z.enum(["offline", "submit"]),
    instances: z.array(
      z.object({
        source: z.enum(["greenhouse", "lever", "ashby", "cbs"]),
        boardToken: z.string(),
        region: z.enum(["", "global", "eu"]),
      }),
    ),
    mbaInternship: z.boolean(),
    postMbaFulltime: z.boolean(),
    generalProfessional: z.boolean(),
    // Optional role scope: three category switches plus the internship-only level restriction.
    scopeInternshipOnly: z.boolean(),
    scopeTechProductManagement: z.boolean(),
    scopeMbbConsulting: z.boolean(),
    scopeBuySideInvesting: z.boolean(),
    dailyCap: z
      .number()
      .int()
      .min(1, "At least 1 per day.")
      .max(50, "The plan caps runs at 50 per day."),
    maxApplications: z.number().int().min(1, "At least 1.").max(10000),
    timezone: z.string().min(1).refine(isTimezone, "IANA timezone, e.g. America/New_York."),
  })
  .superRefine((v, ctx) => {
    if (v.instances.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Add at least one source board.",
        path: ["instances"],
      });
    }
    for (const [index, instance] of v.instances.entries()) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(instance.boardToken.trim())) {
        ctx.addIssue({
          code: "custom",
          message: "Board tokens are letters, digits, _ or -.",
          path: ["instances", index, "boardToken"],
        });
      }
    }
    if (!v.mbaInternship && !v.postMbaFulltime && !v.generalProfessional) {
      for (const field of TRACK_FIELDS) {
        ctx.addIssue({ code: "custom", message: "Pick at least one track.", path: [field.name] });
      }
    }
    // The contract requires 1-3 categories whenever roleScope is present, so an
    // internship-only switch with nothing picked cannot be submitted as a scope.
    if (v.scopeInternshipOnly && SCOPE_CATEGORY_FIELDS.every((f) => !v[f.name])) {
      ctx.addIssue({
        code: "custom",
        message: "Pick at least one category to scope internships.",
        path: ["scopeInternshipOnly"],
      });
    }
  });

type CampaignFormValues = z.infer<typeof campaignFormSchema>;
type CampaignInstance = CampaignFormValues["instances"][number];

const INSTANCE_DEFAULT: CampaignInstance = {
  source: "greenhouse",
  boardToken: "",
  region: "",
};

const CAMPAIGN_DEFAULTS: CampaignFormValues = {
  name: "",
  // Offline by default: creating a campaign must never imply real submissions.
  mode: "offline",
  instances: [{ ...INSTANCE_DEFAULT }],
  mbaInternship: true,
  postMbaFulltime: true,
  generalProfessional: true,
  // Unscoped by default: all functions across graduate and experienced tracks.
  scopeInternshipOnly: false,
  scopeTechProductManagement: false,
  scopeMbbConsulting: false,
  scopeBuySideInvesting: false,
  dailyCap: 5,
  maxApplications: 50,
  timezone: "America/New_York",
};

/** Ranking is descending continuous score only; this constant satisfies the older contract shape. */
const FIT_THRESHOLD_COMPAT = 0;

function toCreateInput(values: CampaignFormValues): PersonalCampaignCreateInput {
  const categories = SCOPE_CATEGORY_FIELDS.filter((f) => values[f.name]).map((f) => f.category);
  const instances = values.instances.map((instance) => ({
    source: instance.source,
    boardToken: instance.boardToken.trim(),
    ...(instance.region !== "" && { region: instance.region }),
  }));
  return {
    name: values.name.trim(),
    mode: values.mode,
    sources: {
      // Greenhouse tokens stay in the compatibility field; every board also lands in instances.
      boardTokens: instances
        .filter((instance) => instance.source === "greenhouse")
        .map((instance) => instance.boardToken),
      instances,
    },
    tracks: TRACK_FIELDS.filter((f) => values[f.name]).map((f) => f.track),
    // Absent — not null/false placeholders — when nothing is picked.
    ...(categories.length > 0 && {
      roleScope: { internshipOnly: values.scopeInternshipOnly, categories },
    }),
    fitThreshold: FIT_THRESHOLD_COMPAT,
    dailyCap: values.dailyCap,
    maxApplications: values.maxApplications,
    timezone: values.timezone.trim(),
  };
}

/** Everything that will govern the run, stated once, before the single launch authorization. */
function CampaignSummary(props: { campaign: PersonalCampaign }): ReactElement {
  const { campaign } = props;
  const instanceLine =
    campaign.sources.instances && campaign.sources.instances.length > 0
      ? campaign.sources.instances
          .map((instance) =>
            [
              instance.source,
              instance.boardToken,
              ...(instance.region ? [instance.region] : []),
            ].join(":"),
          )
          .join(" · ")
      : campaign.sources.boardTokens.map((token) => `greenhouse:${token}`).join(" · ");
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6, md: 4 }}>
        <LabelValue label="Mode">{MODE_LABEL[campaign.mode]}</LabelValue>
      </Grid>
      <Grid size={{ xs: 12, sm: 6, md: 8 }}>
        <LabelValue label="Sources">{instanceLine}</LabelValue>
      </Grid>
      <Grid size={{ xs: 12, md: 8 }}>
        <LabelValue label="Tracks">
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", gap: 0.75 }}>
            {campaign.tracks.map((track) => (
              <Chip key={track} size="small" variant="outlined" label={TRACK_LABEL[track]} />
            ))}
          </Stack>
        </LabelValue>
      </Grid>
      <Grid size={{ xs: 6, sm: 3, md: 2 }}>
        <LabelValue label="Fit ranking">Descending score — no cutoff</LabelValue>
      </Grid>
      <Grid size={{ xs: 6, sm: 3, md: 2 }}>
        <LabelValue label="Daily cap">{campaign.dailyCap}</LabelValue>
      </Grid>
      <Grid size={{ xs: 6, sm: 3, md: 2 }}>
        <LabelValue label="Max applications">{campaign.maxApplications}</LabelValue>
      </Grid>
      <Grid size={{ xs: 6, sm: 3, md: 4 }}>
        <LabelValue label="Timezone">{campaign.timezone}</LabelValue>
      </Grid>
      <Grid size={{ xs: 12, md: 8 }}>
        <LabelValue label="Role scope">
          {campaign.roleScope
            ? scopeLine(campaign.roleScope)
            : "All functions — graduate and experienced"}
        </LabelValue>
      </Grid>
    </Grid>
  );
}

/**
 * Campaign configuration and lifecycle. A campaign is always created stopped; launch is the
 * one explicit authorization for the whole run — there is no per-job confirmation flow.
 */
export function CampaignCard(): ReactElement {
  const campaigns = useApiQuery(personalQueries.campaigns());
  const [launchTarget, setLaunchTarget] = useState<PersonalCampaign | null>(null);

  const invalidate = [personalQueryKeys.all];

  const create = useApiMutation<PersonalCampaign, PersonalCampaignCreateInput>(
    (body) => api.personal.campaigns.post(body),
    { successMessage: "Campaign created (stopped)", invalidate },
  );
  const launch = useApiMutation<PersonalCampaign, string>(
    (id) => api.personal.campaigns({ id }).launch.post({ confirm: true }),
    {
      successMessage: "Campaign launched",
      invalidate,
      onSuccess: () => setLaunchTarget(null),
    },
  );
  const stop = useApiMutation<PersonalCampaign, string>(
    (id) => api.personal.campaigns({ id }).stop.post({}),
    { successMessage: "Campaign stopped", invalidate },
  );

  const form = useAppForm({
    defaultValues: CAMPAIGN_DEFAULTS,
    validators: { onSubmit: campaignFormSchema },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(toCreateInput(value));
    },
  });

  const scopeInternshipOnly = useSelector(form.store, (s) => s.values.scopeInternshipOnly);
  const scopePicked = useSelector(
    form.store,
    (s) =>
      s.values.scopeTechProductManagement ||
      s.values.scopeMbbConsulting ||
      s.values.scopeBuySideInvesting,
  );
  // Mirrors the superRefine guard so the invalid state is visible, not just un-submittable.
  const scopeIncomplete = scopeInternshipOnly && !scopePicked;

  const rows = campaigns.data?.items ?? [];

  return (
    <SectionCard
      title="Campaigns"
      description="Configure a run, review it, then launch once. Launch is the authorization — the agent will not ask again per job."
    >
      <Stack spacing={2.5}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <Stack spacing={2}>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <form.AppField name="name">
                  {(field) => <field.TextField label="Name" helperText="For your own reference." />}
                </form.AppField>
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <form.AppField name="mode">
                  {(field) => (
                    <field.Select
                      label="Mode"
                      items={[
                        { value: "offline", label: "Offline" },
                        { value: "submit", label: "Submit" },
                      ]}
                      helperText="Offline prepares and previews only."
                    />
                  )}
                </form.AppField>
              </Grid>
              <Grid size={12}>
                <Stack
                  spacing={1.5}
                  sx={(theme) => ({
                    border: 1,
                    borderColor: theme.palette.line.border,
                    borderRadius: theme.radii.md,
                    p: 1.5,
                  })}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Typography variant="overlineMuted" sx={{ flex: 1 }}>
                      Source boards
                    </Typography>
                    <Button
                      size="small"
                      onClick={() =>
                        form.setFieldValue("instances", [
                          ...form.getFieldValue("instances"),
                          { ...INSTANCE_DEFAULT },
                        ])
                      }
                    >
                      Add board
                    </Button>
                  </Stack>
                  {form.getFieldValue("instances").map((_instance, index) => (
                    // Row identity is the field path, which is stable per index position.
                    // biome-ignore lint/suspicious/noArrayIndexKey: field-array rows are addressed by index in the form state
                    <Grid container spacing={1.5} key={index}>
                      <Grid size={{ xs: 12, sm: 4, md: 3 }}>
                        <form.AppField name={`instances[${index}].source`}>
                          {(field) => (
                            <field.Select
                              label="Source"
                              items={[
                                { value: "greenhouse", label: "Greenhouse" },
                                { value: "lever", label: "Lever" },
                                { value: "ashby", label: "Ashby" },
                                { value: "cbs", label: "CBS" },
                              ]}
                            />
                          )}
                        </form.AppField>
                      </Grid>
                      <Grid size={{ xs: 12, sm: 5, md: 5 }}>
                        <form.AppField name={`instances[${index}].boardToken`}>
                          {(field) => (
                            <field.TextField
                              label="Board token"
                              helperText="Letters, digits, _ or -."
                            />
                          )}
                        </form.AppField>
                      </Grid>
                      <Grid size={{ xs: 8, sm: 2, md: 2 }}>
                        <form.AppField name={`instances[${index}].region`}>
                          {(field) => (
                            <field.Select
                              label="Region"
                              optional
                              emptyLabel="Default"
                              items={[
                                { value: "global", label: "Global" },
                                { value: "eu", label: "EU" },
                              ]}
                            />
                          )}
                        </form.AppField>
                      </Grid>
                      <Grid
                        size={{ xs: 4, sm: 1, md: 2 }}
                        sx={{ alignItems: "center", display: "flex" }}
                      >
                        <Button
                          size="small"
                          color="warning"
                          disabled={form.getFieldValue("instances").length === 1}
                          onClick={() =>
                            form.setFieldValue("instances", [
                              ...form.getFieldValue("instances").slice(0, index),
                              ...form.getFieldValue("instances").slice(index + 1),
                            ])
                          }
                        >
                          Remove
                        </Button>
                      </Grid>
                    </Grid>
                  ))}
                  <Typography variant="captionMuted">
                    Coverage is exactly the boards listed — discovery reads these feeds only and
                    never claims broad market coverage.
                  </Typography>
                </Stack>
              </Grid>
              {TRACK_FIELDS.map((fieldDef) => (
                <Grid key={fieldDef.name} size={{ xs: 12, sm: 4 }}>
                  <form.AppField name={fieldDef.name}>
                    {(f) => <f.Checkbox label={TRACK_LABEL[fieldDef.track]} />}
                  </form.AppField>
                </Grid>
              ))}
              <Grid size={12}>
                <Stack
                  spacing={1}
                  sx={(theme) => ({
                    border: 1,
                    borderColor: theme.palette.line.border,
                    borderRadius: theme.radii.md,
                    p: 1.5,
                  })}
                >
                  <Typography variant="overlineMuted">Role scope (optional)</Typography>
                  <Typography variant="captionMuted">
                    Leave everything unchecked to pursue all functions across graduate and
                    experienced tracks. Internship-only excludes full-time roles — internships still
                    arrive through every track picked above.
                  </Typography>
                  <Grid container spacing={1.5}>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <form.AppField name="scopeInternshipOnly">
                        {(f) => <f.Checkbox label="Internship roles only" />}
                      </form.AppField>
                    </Grid>
                    {SCOPE_CATEGORY_FIELDS.map((fieldDef) => (
                      <Grid key={fieldDef.name} size={{ xs: 12, sm: 6, md: 3 }}>
                        <form.AppField name={fieldDef.name}>
                          {(f) => <f.Checkbox label={CATEGORY_LABEL[fieldDef.category]} />}
                        </form.AppField>
                      </Grid>
                    ))}
                  </Grid>
                </Stack>
              </Grid>
              <Grid size={{ xs: 6, sm: 3 }}>
                <form.AppField name="dailyCap">
                  {(field) => (
                    <field.TextField
                      label="Daily cap"
                      type="number"
                      helperText="Plan maximum: 50 per day."
                      slotProps={{ htmlInput: { min: 1, max: 50, step: 1 } }}
                    />
                  )}
                </form.AppField>
              </Grid>
              <Grid size={{ xs: 6, sm: 3 }}>
                <form.AppField name="maxApplications">
                  {(field) => (
                    <field.TextField
                      label="Max applications"
                      type="number"
                      slotProps={{ htmlInput: { min: 1, max: 10000, step: 1 } }}
                    />
                  )}
                </form.AppField>
              </Grid>
              <Grid size={{ xs: 12, sm: 3 }}>
                <form.AppField name="timezone">
                  {(field) => (
                    <field.TextField label="Timezone" helperText="e.g. America/New_York" />
                  )}
                </form.AppField>
              </Grid>
            </Grid>
            <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
              {scopeIncomplete && (
                <Alert severity="warning" sx={{ flex: 1, py: 0 }}>
                  Pick at least one category to scope internships.
                </Alert>
              )}
              <form.AppForm>
                <form.SubmitButton disabled={create.isPending || scopeIncomplete}>
                  Create (stopped)
                </form.SubmitButton>
              </form.AppForm>
            </Stack>
          </Stack>
        </form>

        {campaigns.isLoading ? (
          <LinearProgress />
        ) : rows.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No campaigns yet."
            description="Created campaigns start stopped; launch is a separate, explicit step."
          />
        ) : (
          <Stack spacing={2}>
            {rows.map((campaign) => (
              <Stack
                key={campaign.id}
                spacing={1.5}
                sx={(theme) => ({
                  border: 1,
                  borderColor: theme.palette.line.border,
                  borderRadius: theme.radii.md,
                  p: 1.5,
                })}
              >
                <Stack
                  direction="row"
                  spacing={1.25}
                  sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                >
                  <Typography variant="body2Strong">{campaign.name}</Typography>
                  <ColorChip
                    value={campaign.status}
                    colors={{ active: "success", stopped: "default" }}
                    label={campaign.status === "active" ? "Active" : "Stopped"}
                  />
                  <Chip size="small" variant="outlined" label={MODE_LABEL[campaign.mode]} />
                  {campaign.roleScope && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        campaign.roleScope.internshipOnly
                          ? `Internships only · ${campaign.roleScope.categories.length} categories`
                          : `${campaign.roleScope.categories.length} categories`
                      }
                    />
                  )}
                  <Box sx={{ flex: 1 }} />
                  <RelativeTime value={campaign.updatedAt} />
                  {campaign.status === "stopped" ? (
                    <Button
                      size="small"
                      variant="contained"
                      color="success"
                      startIcon={<Launch fontSize="sm" />}
                      onClick={() => setLaunchTarget(campaign)}
                    >
                      Review & launch
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant="outlined"
                      color="warning"
                      startIcon={<StopCircle fontSize="sm" />}
                      disabled={stop.isPending}
                      onClick={() => stop.mutate(campaign.id)}
                    >
                      Stop
                    </Button>
                  )}
                </Stack>
                <CampaignSummary campaign={campaign} />
                {campaign.authorization && (
                  <Typography variant="captionMuted">
                    Authorized <RelativeTime value={campaign.authorization.authorizedAt} /> · policy{" "}
                    {campaign.authorization.settingsHash.slice(0, 8)}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>

      <Dialog open={launchTarget !== null} maxWidth="md" fullWidth>
        <DialogTitle>Launch “{launchTarget?.name}”?</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity={launchTarget?.mode === "submit" ? "warning" : "info"}>
              {launchTarget?.mode === "submit"
                ? "Submit mode: launching authorizes real submissions to employers for matching jobs, up to the caps below. The agent will not ask again per job."
                : "Offline mode: the run prepares previews and documents only. Nothing is sent to employers."}
            </Alert>
            {launchTarget && <CampaignSummary campaign={launchTarget} />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLaunchTarget(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="success"
            disabled={launch.isPending}
            onClick={() => launchTarget && launch.mutate(launchTarget.id)}
          >
            Launch campaign
          </Button>
        </DialogActions>
      </Dialog>
    </SectionCard>
  );
}
