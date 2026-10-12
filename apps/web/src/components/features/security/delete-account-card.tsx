"use client";

import { type ReactElement, useState } from "react";
import {
  confirmsAccountEmail,
  type DeleteAccountInput,
  DeleteAccountSchema,
} from "@jobpilot/contracts/auth";
import { Alert, Button, Stack, Typography } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/api/client";
import { useApiMutation } from "@/api/hooks";
import type { DeleteAccountResponse } from "@/api/types";
import { FormDialogShell } from "@/components/ui/form";
import { useAppForm } from "@/components/ui/form/tanstack";
import { SectionCard } from "@/components/ui/layout/section-card";
import { useSession } from "@/hooks/use-auth";

const DEFAULT_VALUES: DeleteAccountInput = { confirmation: "", currentPassword: "" };

/** Permanent self-serve deletion, behind a dialog that asks for the sign-in email. */
export function DeleteAccountCard(): ReactElement {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const deleteAccount = useApiMutation<DeleteAccountResponse, DeleteAccountInput>(
    (body) => api.auth.account.delete(body),
    {
      showErrorToast: false,
      successMessage: "Your account was deleted",
      onSuccess: () => {
        queryClient.clear();
        router.replace("/login");
      },
    },
  );

  const form = useAppForm({
    defaultValues: DEFAULT_VALUES,
    validators: { onSubmit: DeleteAccountSchema },
    // mutate, not mutateAsync: the dialog shows the error, so a rejection must not escape handleSubmit.
    onSubmit: ({ value }) => {
      deleteAccount.mutate(value);
    },
  });

  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const close = () => {
    setOpen(false);
    form.reset();
    deleteAccount.reset();
  };

  return (
    <SectionCard
      title="Delete account"
      description="Permanently erase your account and everything in it. This cannot be undone."
    >
      <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
        {isSuperAdmin && <Alert severity="info">The super admin account cannot be deleted.</Alert>}
        <Button
          variant="outlined"
          color="error"
          disabled={isSuperAdmin}
          onClick={() => setOpen(true)}
        >
          Delete account
        </Button>
      </Stack>

      <FormDialogShell
        open={open}
        title="Delete your account?"
        onClose={close}
        onSubmit={() => {
          form.handleSubmit();
        }}
        submit={
          <form.Subscribe selector={(state) => state.values.confirmation}>
            {(confirmation) => (
              <form.AppForm>
                <form.SubmitButton
                  color="error"
                  disabled={
                    deleteAccount.isPending ||
                    !confirmsAccountEmail(confirmation, user?.email ?? "")
                  }
                >
                  {deleteAccount.isPending ? "Deleting…" : "Delete permanently"}
                </form.SubmitButton>
              </form.AppForm>
            )}
          </form.Subscribe>
        }
      >
        <Typography variant="body2">
          This deletes your resumes and their files, applications, campaigns, contacts, cover
          letters, API tokens and connected accounts. Type <strong>{user?.email}</strong> to
          confirm.
        </Typography>

        {deleteAccount.error && <Alert severity="error">{deleteAccount.error.message}</Alert>}

        <form.AppField name="confirmation">
          {(field) => <field.TextField label="Your sign-in email" autoComplete="off" />}
        </form.AppField>

        {user?.hasPassword && (
          <form.AppField name="currentPassword">
            {(field) => (
              <field.TextField
                label="Current password"
                type="password"
                autoComplete="current-password"
              />
            )}
          </form.AppField>
        )}
      </FormDialogShell>
    </SectionCard>
  );
}
