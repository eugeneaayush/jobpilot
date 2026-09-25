"use client";

import { type ReactElement, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import type {
  PersonalScreeningAnswer,
  personalScreeningAnswersResponseSchema,
} from "@jobpilot/contracts/personal-readiness";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { z } from "zod/v4";
import { api } from "@/api/client";
import { apiErrorMessage, type EdenResult } from "@/api/error";
import { useApiMutation, useApiQuery } from "@/api/hooks";
import { personalQueries, personalQueryKeys } from "@/api/personal";
import { LabelValue, RelativeTime } from "@/components/ui/display";
import { LoadingSpinner } from "@/components/ui/feedback";
import { useToast } from "@/providers/notification-provider";

interface AnswersDialogProps {
  record: PersonalRecordDto | null;
  open: boolean;
  onClose: () => void;
}

/** The contract exports DTO types for the parts we name; the response envelope derives here. */
type PersonalScreeningAnswersResponse = z.infer<typeof personalScreeningAnswersResponseSchema>;

const SOURCE_LABEL = {
  explicit_user: "you confirmed",
  delegated_preference: "delegated privacy preference",
  settings: "from settings",
  resume: "from resume",
  resume_normalized: "formatted from resume",
} as const;

/**
 * Draft keys for questions that have no snapshot answer yet. The contract's key charset is
 * [a-zA-Z0-9_.:-]; this deterministic slug is shown beside each field so nothing is implied.
 */
function answerKey(question: string): string {
  return (
    question
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "question"
  );
}

interface DraftRow {
  key: string;
  label: string;
  fieldName?: string;
  type: string;
  saved: PersonalScreeningAnswer | null;
}

/** Union of saved snapshot answers and the record's open questions, keyed for the draft. */
function draftRows(
  snapshotAnswers: PersonalScreeningAnswer[],
  missingAnswers: string[],
  questions: PersonalScreeningAnswersResponse["questions"],
): DraftRow[] {
  const rows: DraftRow[] = snapshotAnswers.map(
    (answer): DraftRow => ({
      key: answer.key,
      label: answer.label ?? answer.fieldName ?? answer.key,
      fieldName: answer.fieldName,
      type: typeof answer.value === "boolean" ? "checkbox" : "text",
      saved: answer,
    }),
  );
  const known = new Set(rows.map((row) => row.key));
  for (const question of questions) {
    const existing = rows.find(
      (row) =>
        (question.fieldName && row.fieldName === question.fieldName) ||
        row.label === question.label,
    );
    if (existing) {
      existing.type = question.type;
      existing.fieldName ||= question.fieldName;
      continue;
    }
    let key = answerKey(question.fieldName || question.label).slice(0, 140);
    while (known.has(key)) key += "-q";
    rows.push({
      key,
      label: question.label || question.fieldName,
      fieldName: question.fieldName || undefined,
      type: question.type,
      saved: null,
    });
    known.add(key);
  }
  for (const question of missingAnswers) {
    const key = answerKey(question);
    if (!known.has(key) && !rows.some((row) => row.label === question)) {
      rows.push({ key, label: question, type: "text", saved: null });
      known.add(key);
    }
  }
  return rows;
}

interface DraftFormProps {
  record: PersonalRecordDto;
  data: PersonalScreeningAnswersResponse;
  onReload: () => void;
  onClose: () => void;
}

function DraftForm(props: DraftFormProps): ReactElement {
  const { record, data, onReload, onClose } = props;
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [stale, setStale] = useState(false);
  const snapshot = data.snapshot;
  const locked = ["applying", "submitted", "submission_uncertain"].includes(record.state);
  const rows = draftRows(snapshot?.answers ?? [], record.missingAnswers, data.questions);

  // A changed question type requires a new answer, never a guessed conversion.
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      rows
        .filter((row) =>
          row.type === "checkbox"
            ? typeof row.saved?.value === "boolean"
            : typeof row.saved?.value === "string",
        )
        .map((row) => [row.key, row.saved!.value]),
    ),
  );

  const save = useApiMutation<PersonalScreeningAnswersResponse, PersonalScreeningAnswer[]>(
    async (answers) => {
      const result: EdenResult<PersonalScreeningAnswersResponse> = await api.personal.readiness
        .records({ id: record.id })
        .answers.post({
          expectedUpdatedAt: new Date(data.updatedAt).toISOString(),
          answers,
        });
      if (result.error) {
        // 409 = expectedUpdatedAt mismatch: the snapshot moved under the draft.
        if ((result.error as { status?: unknown }).status === 409) {
          throw new Error("stale-snapshot");
        }
        throw new Error(apiErrorMessage(result.error));
      }
      return result;
    },
    {
      showErrorToast: false,
      invalidate: [personalQueryKeys.all],
      onSuccess: () => toast.success("Screening answers saved"),
      onError: (error) => {
        if (error.message === "stale-snapshot") {
          setStale(true);
          return;
        }
        toast.error(error.message);
      },
    },
  );

  const filled = rows.filter((row) => {
    const value = values[row.key];
    return typeof value === "boolean" || (typeof value === "string" && value.trim() !== "");
  });
  const canSave = filled.length > 0 || (snapshot?.answers.length ?? 0) > 0;

  const submit = (): void => {
    if (locked || !confirmed || !canSave) return;
    save.mutate(
      filled.map((row) => ({
        key: row.key,
        value:
          typeof values[row.key] === "boolean"
            ? values[row.key]
            : String(values[row.key] ?? "").trim(),
        ...(row.fieldName ? { fieldName: row.fieldName } : {}),
        label: row.label,
        source: { kind: "explicit_user", confirmed: true },
      })),
    );
  };

  const reload = (): void => {
    setStale(false);
    setConfirmed(false);
    onReload();
  };

  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      {locked && (
        <Alert severity="info">
          This application is active or may already be submitted. Resolve it before replacing its
          answers.
        </Alert>
      )}
      {stale && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={reload}>
              Reload latest
            </Button>
          }
        >
          These answers changed while you were editing (the snapshot was regenerated). Your draft
          was not saved — reload the latest answers and re-confirm.
        </Alert>
      )}

      {snapshot ? (
        <Stack spacing={1}>
          <Typography variant="overlineMuted">Saved snapshot</Typography>
          <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", gap: 2 }}>
            <LabelValue label="Created">
              <RelativeTime value={snapshot.createdAt} variant="body2" />
            </LabelValue>
            <LabelValue label="Snapshot hash">
              <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                {snapshot.snapshotHash.slice(0, 16)}
              </Typography>
            </LabelValue>
          </Stack>
          <Stack spacing={0.5}>
            {snapshot.answers.map((answer) => (
              <Stack
                key={answer.key}
                direction="row"
                spacing={1}
                sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
              >
                <Chip size="small" variant="outlined" label={SOURCE_LABEL[answer.source.kind]} />
                <Typography variant="body2" sx={{ minWidth: 0, wordBreak: "break-word" }}>
                  {answer.label ?? answer.fieldName ?? answer.key}: {String(answer.value)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Stack>
      ) : (
        <Alert severity="info">No answers saved for this record yet.</Alert>
      )}

      {data.requiresPreview && (
        <Alert severity="info">
          A preview must be generated before these answers take effect in a run.
        </Alert>
      )}

      <Stack spacing={1.5}>
        <Typography variant="overlineMuted">Your answers</Typography>
        {rows.map((row) => (
          <Stack key={row.key} spacing={0.5}>
            <TextField
              label={row.label}
              select={row.type === "checkbox"}
              value={
                row.type === "checkbox" && typeof values[row.key] === "boolean"
                  ? String(values[row.key])
                  : (values[row.key] ?? "")
              }
              onChange={(e) => {
                const value =
                  row.type === "checkbox" && e.target.value !== ""
                    ? e.target.value === "true"
                    : e.target.value;
                setValues((prev) => ({ ...prev, [row.key]: value }));
                setConfirmed(false);
              }}
              disabled={locked || stale || save.isPending}
              fullWidth
            >
              {row.type === "checkbox" && [
                <MenuItem key="unset" value="">
                  Not answered
                </MenuItem>,
                <MenuItem key="true" value="true">
                  Yes / checked
                </MenuItem>,
                <MenuItem key="false" value="false">
                  No / unchecked
                </MenuItem>,
              ]}
            </TextField>
            <Typography variant="captionMuted">key: {row.key}</Typography>
          </Stack>
        ))}
        <Alert severity="info">
          Nothing is autofilled. Values start from your own saved answers only, and every saved
          answer is recorded as explicitly confirmed by you. Saving replaces this snapshot; clearing
          a field removes its saved answer.
        </Alert>
        <FormControlLabel
          control={
            <Checkbox
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={locked || stale || save.isPending}
            />
          }
          label="I confirm these values are my own answers, exactly as entered."
        />
      </Stack>

      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          disabled={locked || !confirmed || !canSave || stale || save.isPending}
          onClick={submit}
        >
          Save answers
        </Button>
      </Stack>
    </Stack>
  );
}

/** Per-record screening answers: saved snapshot shown, new values require explicit confirmation. */
export function AnswersDialog(props: AnswersDialogProps): ReactElement {
  const { record, open, onClose } = props;
  const answers = useApiQuery(
    personalQueries.screeningAnswers(record?.id ?? "00000000-0000-0000-0000-000000000000"),
    // One def keeps the response type; enabled gates the fetch until a record is picked.
    { enabled: record !== null },
  );
  // A reload bumps the nonce so the form remounts and re-seeds from the fresh snapshot.
  const [reloadNonce, setReloadNonce] = useState(0);

  return (
    <Dialog open={open && record !== null} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {record ? `Screening answers — ${record.title}` : "Screening answers"}
      </DialogTitle>
      <DialogContent>
        {record && answers.data ? (
          <DraftForm
            key={`${record.id}-${String(answers.data.updatedAt)}-${JSON.stringify(answers.data.questions)}-${reloadNonce}`}
            record={record}
            data={answers.data}
            onReload={() => {
              setReloadNonce((nonce) => nonce + 1);
              void answers.refetch();
            }}
            onClose={onClose}
          />
        ) : (
          <LoadingSpinner />
        )}
      </DialogContent>
    </Dialog>
  );
}
