"use client";

import type { ReactElement } from "react";
import type { PersonalDashboard } from "@jobpilot/contracts/personal";
import { Dns } from "@mui/icons-material";
import { Stack, Typography } from "@mui/material";
import { EmptyState } from "@/components/ui/data";
import { ColorChip, ItemList, ItemRow, RelativeTime } from "@/components/ui/display";
import { SectionCard } from "@/components/ui/layout";
import { plural } from "@/utils/format";
import { SOURCE_STATUS_COLOR, SOURCE_STATUS_LABEL } from "./personal-labels";

interface SourcesPanelProps {
  sources: PersonalDashboard["sources"];
}

/** Per-source health: typed status, record count, error text, and when it last ran. */
export function SourcesPanel(props: SourcesPanelProps): ReactElement {
  const { sources } = props;

  return (
    <SectionCard title="Sources" description="Board scans feeding your tracks.">
      {sources.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No sources scanned yet."
          description="Run a discovery to list jobs from a supported board."
        />
      ) : (
        <ItemList>
          {sources.map((s) => (
            <ItemRow
              key={s.id}
              icon={<Dns fontSize="sm" />}
              primary={
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
                >
                  <Typography variant="body2Strong">{s.source}</Typography>
                  <ColorChip
                    value={s.status}
                    colors={SOURCE_STATUS_COLOR}
                    label={SOURCE_STATUS_LABEL[s.status]}
                  />
                  <Typography variant="captionMuted">{plural(s.count, "record")}</Typography>
                </Stack>
              }
              // The error is the part users act on; a source that ran clean shows just its age.
              secondary={s.error ?? undefined}
              action={<RelativeTime value={s.createdAt} />}
            />
          ))}
        </ItemList>
      )}
      <Typography variant="captionMuted" sx={{ display: "block", mt: 2 }}>
        Greenhouse has a guarded submit adapter; Lever has a restricted native-multipart submit
        (custom widgets park, and even an HTTP 2xx stays uncertain until reconciled). Ashby and CBS
        records stay discoverable and park as adapter-required — an honest gap, never a silent skip.
      </Typography>
    </SectionCard>
  );
}
