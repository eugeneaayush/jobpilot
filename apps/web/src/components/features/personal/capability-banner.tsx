"use client";

import type { ReactElement } from "react";
import type { PersonalDashboard } from "@jobpilot/contracts/personal";
import { Alert, Stack } from "@mui/material";

interface CapabilityBannerProps {
  capabilities: PersonalDashboard["capabilities"];
}

/**
 * States the operating envelope explicitly rather than letting missing capabilities
 * read as broken buttons: what is enabled, what isn't, and what setup is missing.
 */
export function CapabilityBanner(props: CapabilityBannerProps): ReactElement {
  const { capabilities } = props;
  const { personalMode, offlinePreview, liveSubmissions, missingSetup } = capabilities;

  return (
    <Stack spacing={1.5}>
      {!personalMode && (
        <Alert severity="error">
          Personal mode is not enabled for this account. Everything below is read-only until it is.
        </Alert>
      )}
      {missingSetup.length > 0 && (
        <Alert severity="warning">
          Live execution is blocked: {missingSetup.join(", ")}. Review these items before launching
          a submit campaign.
        </Alert>
      )}
      <Alert severity="info">
        {offlinePreview
          ? "Previews run offline against your local documents — nothing is sent to the employer."
          : "Offline preview is not available from this build, so no preview can be generated yet."}{" "}
        {liveSubmissions
          ? "Live submissions require an explicitly launched campaign."
          : "Live submissions are blocked by the current readiness checks."}
      </Alert>
    </Stack>
  );
}
