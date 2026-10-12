import {
  type ChangeEmailInput,
  type ChangePasswordInput,
  confirmsAccountEmail,
  type DeleteAccountInput,
} from "@jobpilot/contracts";
import { singleton } from "tsyringe";
import { hashPassword, hashToken, verifyPassword } from "@/common/auth";
import { CryptoService } from "@/common/crypto/crypto.service";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "@/common/errors";
import { logger } from "@/common/logger";
import { deleteAllResumeArtifacts } from "@/common/storage/storage";
import { normalizeEmail } from "@/common/utils/email";
import { env } from "@/env";
import { PrismaClient, UserRole } from "@/generated/prisma/client";
import { deleteAccountRecords } from "./account-deletion";
import { revokeRefreshTokens } from "./revoke-refresh-tokens";
import { VerificationService } from "./verification.service";

/** Password change/set, the email-change request gate, and self-serve account deletion. */
@singleton()
export class SecurityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly verification: VerificationService,
    private readonly crypto: CryptoService,
  ) {}

  /** Verify the current password when the account has one; OAuth-only accounts skip it. */
  private async requireCurrentPassword(
    passwordHash: string | null,
    currentPassword: string | undefined,
  ): Promise<void> {
    if (passwordHash === null) {
      return;
    }
    if (!currentPassword) {
      throw badRequest("Current password is required");
    }
    if (!(await verifyPassword(currentPassword, passwordHash))) {
      throw unauthorized("Current password is incorrect");
    }
  }

  /** Change or first-set the password; revokes every session except the caller's. */
  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    currentRefreshRaw: string | null,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) {
      throw notFound("User not found");
    }
    await this.requireCurrentPassword(user.passwordHash, input.currentPassword);

    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      revokeRefreshTokens(this.prisma, userId, currentRefreshRaw),
    ]);
    return { ok: true };
  }

  /** Gate an email change, then mail the confirmation link; nothing switches until clicked. */
  async requestEmailChange(userId: string, input: ChangeEmailInput): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true },
    });
    if (!user) {
      throw notFound("User not found");
    }
    await this.requireCurrentPassword(user.passwordHash, input.currentPassword);

    const newEmail = normalizeEmail(input.newEmail);
    if (newEmail === user.email) {
      throw badRequest("This is already your sign-in email");
    }
    const taken = await this.prisma.user.findUnique({
      where: { email: newEmail },
      select: { id: true },
    });
    if (taken) {
      throw conflict("Email already in use");
    }

    await this.verification.sendEmailChangeEmail(userId, newEmail);
    return { ok: true };
  }

  /** Permanently delete the caller's account and every record it owns, then its resume files. */
  async deleteAccount(
    userId: string,
    input: DeleteAccountInput,
    refreshRaw: string | null,
  ): Promise<{ ok: true }> {
    if (env.PERSONAL_MODE) {
      throw forbidden("The private account is managed by personal:setup");
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true, role: true },
    });
    if (!user) {
      throw notFound("User not found");
    }
    if (user.role === UserRole.SUPER_ADMIN) {
      throw forbidden("The super admin account cannot be deleted");
    }
    if (!confirmsAccountEmail(input.confirmation, user.email)) {
      throw badRequest("Type your sign-in email exactly to confirm");
    }
    // Agent and terminal tokens also pass authGuard; only a browser session holds a refresh cookie.
    const session = refreshRaw
      ? await this.prisma.refreshToken.findFirst({
          where: {
            userId,
            tokenHash: hashToken(refreshRaw),
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        })
      : null;
    if (!session) {
      throw forbidden("Sign in again in your browser to delete your account");
    }
    await this.requireCurrentPassword(user.passwordHash, input.currentPassword);

    const files = await deleteAccountRecords(this.prisma, userId);
    this.crypto.forget(userId);
    const results = await Promise.allSettled(files.map(deleteAllResumeArtifacts));
    if (results.some((result) => result.status === "rejected")) {
      logger.warn({ userId }, "Some resume files of a deleted account could not be removed");
    }
    return { ok: true };
  }
}
