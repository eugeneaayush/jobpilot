import type { Data } from "@jobpilot/api-client";
import type { api } from "@/api/client";

/** The current user (flat: account + profile fields), inferred from `GET /api/auth/me`. */
export type MeResponse = Data<typeof api.auth.me.get>;
export type AuthUserDto = MeResponse;

/** Login/register response (tokens are ignored - auth rides the httpOnly cookie). */
export type AuthSessionResponse = Data<typeof api.auth.login.post>;

export type LogoutResponse = Data<typeof api.auth.logout.post>;

/** Account-recovery responses (verify email, forgot/reset password, resend). */
export type VerifyEmailResponse = Data<typeof api.auth.email.verify.post>;
export type ResendVerificationResponse = Data<typeof api.auth.email.resend.post>;
export type ForgotPasswordResponse = Data<typeof api.auth.password.forgot.post>;
export type ResetPasswordResponse = Data<typeof api.auth.password.reset.post>;

/** Account security responses (password/email change, provider unlink, account deletion). */
export type ChangePasswordResponse = Data<typeof api.auth.password.change.post>;
export type ChangeEmailResponse = Data<typeof api.auth.email.change.post>;
export type ConfirmEmailChangeResponse = Data<typeof api.auth.email.change.confirm.post>;
export type UnlinkOAuthResponse = Data<ReturnType<typeof api.auth.providers>["delete"]>;
export type DeleteAccountResponse = Data<typeof api.auth.account.delete>;
