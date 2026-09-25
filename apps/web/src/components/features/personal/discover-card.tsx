"use client";

import { type ReactElement, useState } from "react";
import type {
  personalDiscoverSchema,
  personalDiscoveryResponseSchema,
} from "@jobpilot/contracts/personal";
import { TravelExplore } from "@mui/icons-material";
import { Alert, Button, Stack, Typography } from "@mui/material";
import { useSelector } from "@tanstack/react-form";
import { z } from "zod/v4";
import { api } from "@/api/client";
import { useApiMutation } from "@/api/hooks";
import { personalQueryKeys } from "@/api/personal";
import { ColorChip } from "@/components/ui/display";
import { useAppForm } from "@/components/ui/form/tanstack";
import { SectionCard } from "@/components/ui/layout";
import { plural } from "@/utils/format";
import { SOURCE_STATUS_COLOR, SOURCE_STATUS_LABEL } from "./personal-labels";

type DiscoveryResponse = z.infer<typeof personalDiscoveryResponseSchema>;
/** Exact POST body (post-default resolution); the "" region placeholder never leaves the form. */
type DiscoverBody = z.output<typeof personalDiscoverSchema>;

type DiscoverSource = "greenhouse" | "lever" | "ashby" | "cbs";

/** Live public feeds; CBS postings arrive as a local paste, never a fetch. */
const SOURCE_OPTIONS = [
  { value: "greenhouse", label: "Greenhouse" },
  { value: "lever", label: "Lever" },
  { value: "ashby", label: "Ashby" },
  { value: "cbs", label: "CBS (paste listings)" },
] as const satisfies ReadonlyArray<{ value: DiscoverSource; label: string }>;

const REGION_OPTIONS = [
  { value: "global", label: "Global" },
  { value: "eu", label: "EU" },
] as const;

// Mirrors personalDiscoverSchema with field-level messages.
const discoverFormSchema = z
  .object({
    source: z.enum(["greenhouse", "lever", "ashby", "cbs"]),
    boardToken: z.string(),
    region: z.enum(["", "global", "eu"]),
    employer: z.string(),
    importText: z.string(),
    importFormat: z.enum(["csv", "json"]),
    sourceUrl: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.source === "cbs") {
      if (v.importText.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Paste the CBS listings (CSV or JSON) you saved locally.",
          path: ["importText"],
        });
      }
      if (v.sourceUrl.trim() !== "" && !/^https?:\/\/.+$/.test(v.sourceUrl.trim())) {
        ctx.addIssue({
          code: "custom",
          message: "Source URL must be http(s).",
          path: ["sourceUrl"],
        });
      }
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(v.boardToken.trim())) {
      ctx.addIssue({
        code: "custom",
        message: "A board token: 1-100 letters, digits, _ or -.",
        path: ["boardToken"],
      });
    }
  });

interface DiscoverFormValues {
  source: DiscoverSource;
  boardToken: string;
  region: "" | "global" | "eu";
  employer: string;
  importText: string;
  importFormat: "csv" | "json";
  sourceUrl: string;
}

const DISCOVER_DEFAULTS: DiscoverFormValues = {
  source: "greenhouse",
  boardToken: "",
  region: "",
  employer: "",
  importText: "",
  importFormat: "csv",
  sourceUrl: "",
};

interface DiscoverCardProps {
  /** Discovery writes through the API; personal mode off means the button can only fail. */
  discoverEnabled: boolean;
}

/** Discovery across supported sources; CBS listings arrive as a local paste. */
export function DiscoverCard(props: DiscoverCardProps): ReactElement {
  const { discoverEnabled } = props;
  const [result, setResult] = useState<DiscoveryResponse | null>(null);

  const discover = useApiMutation<DiscoveryResponse, DiscoverBody>(
    (body) => api.personal.discover.post(body),
    {
      invalidate: [personalQueryKeys.all],
      onSuccess: (data) => setResult(data),
    },
  );

  const form = useAppForm({
    defaultValues: DISCOVER_DEFAULTS,
    validators: { onSubmit: discoverFormSchema },
    onSubmit: async ({ value }) => {
      const employer = value.employer.trim();
      const sourceUrl = value.sourceUrl.trim();
      const isCbs = value.source === "cbs";
      await discover.mutateAsync({
        source: value.source,
        boardToken: isCbs ? "cbs-paste" : value.boardToken.trim(),
        ...(value.region !== "" && { region: value.region }),
        ...(employer && { employer }),
        ...(isCbs && { importText: value.importText, importFormat: value.importFormat }),
        ...(isCbs && sourceUrl !== "" && { sourceUrl }),
      });
    },
  });

  const source = useSelector(form.store, (s) => s.values.source);
  const isCbs = source === "cbs";

  return (
    <SectionCard
      title="Discover"
      description="List jobs into your tracks. Greenhouse, Lever, and Ashby read their public feeds; CBS postings are imported from a local paste."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          sx={{ alignItems: { md: "center" } }}
        >
          <form.AppField name="source">
            {(field) => (
              <field.Select
                label="Source"
                items={SOURCE_OPTIONS}
                helperText="Where listings come from."
              />
            )}
          </form.AppField>
          <form.AppField name="region">
            {(field) => (
              <field.Select
                label="Region"
                items={REGION_OPTIONS}
                optional
                emptyLabel="Default"
                helperText="Regional feed variant, where a source offers one."
              />
            )}
          </form.AppField>
          <form.AppField name="employer">
            {(field) => (
              <field.TextField
                label="Employer (optional)"
                helperText="Limit a feed scan to one employer."
              />
            )}
          </form.AppField>
          <Button
            type="submit"
            variant="contained"
            startIcon={<TravelExplore fontSize="sm" />}
            disabled={!discoverEnabled}
          >
            Discover
          </Button>
        </Stack>
        {isCbs ? (
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            <form.AppField name="importText">
              {(field) => (
                <field.TextField
                  label="Pasted CBS listings"
                  multiline
                  minRows={4}
                  helperText="Paste the listings you saved locally — nothing is fetched from CBS."
                />
              )}
            </form.AppField>
            <form.AppField name="importFormat">
              {(field) => (
                <field.Select
                  label="Paste format"
                  items={[
                    { value: "csv", label: "CSV" },
                    { value: "json", label: "JSON" },
                  ]}
                />
              )}
            </form.AppField>
            <form.AppField name="sourceUrl">
              {(field) => (
                <field.TextField
                  label="Provenance URL (optional)"
                  helperText="Where the pasted listings were originally seen, for the record."
                />
              )}
            </form.AppField>
          </Stack>
        ) : (
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            <form.AppField name="boardToken">
              {(field) => (
                <field.TextField
                  label="Board token"
                  helperText="The employer's board identifier on the chosen source."
                />
              )}
            </form.AppField>
          </Stack>
        )}
        <Typography variant="captionMuted" sx={{ display: "block", mt: 1.5 }}>
          Coverage is per-source and per-employer: a discovery only reads the boards you name — it
          never claims broad market coverage.
        </Typography>
      </form>
      {result && (
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: "center", mt: 2, flexWrap: "wrap", gap: 1 }}
        >
          <ColorChip
            value={result.status}
            colors={SOURCE_STATUS_COLOR}
            label={SOURCE_STATUS_LABEL[result.status]}
          />
          <Typography variant="body2">{plural(result.count, "job")} discovered</Typography>
          <Typography variant="captionMuted" sx={{ wordBreak: "break-all" }}>
            run {result.runId}
          </Typography>
        </Stack>
      )}
      {!discoverEnabled && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Discovery requires personal mode; the button stays unavailable until then.
        </Alert>
      )}
    </SectionCard>
  );
}
