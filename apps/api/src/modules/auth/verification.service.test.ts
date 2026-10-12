import { hashToken } from "@/common/auth/tokens";
import {
  emailChangeEmailSubject,
  passwordResetEmailSubject,
  verificationEmailSubject,
} from "@/common/mail";
import { env } from "@/env";
import { type AuthDbState, freezeClock, makeAuthDb, makeMailer, type SentMail } from "./fakes";
import { VerificationService } from "./verification.service";
import { afterEach, describe, expect, it } from "bun:test";

const BASE = Date.parse("2026-10-12T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type Row = Record<string, unknown>;

let restoreClock: (() => void) | undefined;

const make = (users: Row[] = []) => {
  const { db, rows } = makeAuthDb({ users });
  const { mailer, sent } = makeMailer();
  return { service: new VerificationService(db, mailer), rows, sent };
};

const user = (over: Row = {}) => ({
  id: "user-1",
  email: "user@example.test",
  passwordHash: null,
  emailVerified: false,
  ...over,
});

const rawFrom = (mail: SentMail) => mail.link.split("token=")[1] as string;

/** A verification-token row for a known raw value, expired by default. */
function tokenRow(raw: string, over: Row = {}) {
  return {
    id: `vt-${raw}`,
    userId: "user-1",
    type: "EMAIL_VERIFICATION",
    tokenHash: hashToken(raw),
    consumedAt: null,
    expiresAt: new Date(0),
    newEmail: null,
    ...over,
  };
}

function refreshRow(rows: AuthDbState, raw: string, over: Row = {}) {
  const row = {
    id: `refresh-${rows.refreshTokens.length + 1}`,
    userId: "user-1",
    tokenHash: hashToken(raw),
    expiresAt: new Date(BASE + 30 * DAY_MS),
    revokedAt: null,
    ...over,
  };
  rows.refreshTokens.push(row);
  return row;
}

afterEach(() => restoreClock?.());

describe("sendVerificationEmail", () => {
  it("emails a link and stores only its hash, expiring in a day", async () => {
    restoreClock = freezeClock(BASE);
    const { service, rows, sent } = make();

    await service.sendVerificationEmail("user-1", "who@example.test");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "who@example.test", subject: verificationEmailSubject });
    expect(sent[0].link).toContain(`${env.APP_URL}/verify-email?token=`);
    expect(rows.verificationTokens).toHaveLength(1);
    expect(rows.verificationTokens[0]).toMatchObject({
      userId: "user-1",
      type: "EMAIL_VERIFICATION",
      consumedAt: null,
      tokenHash: hashToken(rawFrom(sent[0])),
      expiresAt: new Date(BASE + DAY_MS),
    });
  });

  it("supersedes older unconsumed links - only the latest works", async () => {
    const { service, rows, sent } = make([user()]);

    await service.sendVerificationEmail("user-1", "who@example.test");
    await service.sendVerificationEmail("user-1", "who@example.test");

    expect(rows.verificationTokens).toHaveLength(1);
    await expect(service.verifyEmail(rawFrom(sent[0]))).rejects.toMatchObject({ status: 400 });
    await expect(service.verifyEmail(rawFrom(sent[1]))).resolves.toEqual({ ok: true });
  });
});

describe("verifyEmail", () => {
  it("marks the account verified and consumes the token", async () => {
    const { service, rows, sent } = make([user()]);

    await service.sendVerificationEmail("user-1", "user@example.test");
    await service.verifyEmail(rawFrom(sent[0]));

    expect(rows.users[0].emailVerified).toBe(true);
    expect(rows.verificationTokens[0].consumedAt).toBeInstanceOf(Date);
  });

  it("is single-use - a second click on the same link fails", async () => {
    const { service, sent } = make([user()]);
    await service.sendVerificationEmail("user-1", "user@example.test");
    const raw = rawFrom(sent[0]);

    await service.verifyEmail(raw);
    await expect(service.verifyEmail(raw)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: "Invalid or expired token",
    });
  });

  it("rejects an expired token", async () => {
    const { service, rows } = make([user()]);
    rows.verificationTokens.push(tokenRow("expired-raw"));

    await expect(service.verifyEmail("expired-raw")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a token of the wrong type", async () => {
    const { service, rows } = make([user()]);
    rows.verificationTokens.push(
      tokenRow("reset-raw", { type: "PASSWORD_RESET", expiresAt: new Date(BASE + HOUR_MS) }),
    );

    await expect(service.verifyEmail("reset-raw")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an empty token", async () => {
    const { service } = make();

    await expect(service.verifyEmail("")).rejects.toMatchObject({
      status: 400,
      message: "Missing token",
    });
  });
});

describe("resendVerification", () => {
  it("re-sends for an unverified user", async () => {
    const { service, sent } = make([user()]);

    await expect(service.resendVerification("user-1")).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("user@example.test");
  });

  it("does nothing for an already-verified user", async () => {
    const { service, sent } = make([user({ emailVerified: true })]);

    await expect(service.resendVerification("user-1")).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("404s for an unknown user", async () => {
    const { service } = make();

    await expect(service.resendVerification("ghost")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("requestPasswordReset", () => {
  it("emails a reset link expiring in an hour", async () => {
    restoreClock = freezeClock(BASE);
    const { service, rows, sent } = make([user()]);

    await service.requestPasswordReset(" User@Example.TEST ");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "user@example.test", subject: passwordResetEmailSubject });
    expect(sent[0].link).toContain(`${env.APP_URL}/reset-password?token=`);
    expect(rows.verificationTokens).toHaveLength(1);
    expect(rows.verificationTokens[0]).toMatchObject({
      type: "PASSWORD_RESET",
      tokenHash: hashToken(rawFrom(sent[0])),
      expiresAt: new Date(BASE + HOUR_MS),
    });
  });

  it("succeeds without revealing whether the email exists", async () => {
    const { service, rows, sent } = make();

    await expect(service.requestPasswordReset("ghost@example.test")).resolves.toEqual({ ok: true });

    expect(sent).toHaveLength(0);
    expect(rows.verificationTokens).toHaveLength(0);
  });
});

describe("resetPassword", () => {
  it("sets the new password, consumes the token and revokes every session", async () => {
    const { service, rows, sent } = make([
      user({ passwordHash: await Bun.password.hash("Old-Pass-1!") }),
    ]);
    refreshRow(rows, "session-a");
    refreshRow(rows, "session-b");
    refreshRow(rows, "session-c", { revokedAt: new Date(0) });
    await service.requestPasswordReset("user@example.test");

    await expect(service.resetPassword(rawFrom(sent[0]), "New-Pass-2!")).resolves.toEqual({
      ok: true,
    });

    expect(await Bun.password.verify("New-Pass-2!", rows.users[0].passwordHash as string)).toBe(
      true,
    );
    expect(await Bun.password.verify("Old-Pass-1!", rows.users[0].passwordHash as string)).toBe(
      false,
    );
    expect(rows.verificationTokens[0].consumedAt).toBeInstanceOf(Date);
    const revoked = rows.refreshTokens.map((row) => row.revokedAt !== null);
    expect(revoked).toEqual([true, true, true]);
  });

  it("is single-use", async () => {
    const { service, sent } = make([user()]);
    await service.requestPasswordReset("user@example.test");
    const raw = rawFrom(sent[0]);

    await service.resetPassword(raw, "New-Pass-2!");
    await expect(service.resetPassword(raw, "Again-3!")).rejects.toMatchObject({ status: 400 });
  });
});

describe("sendEmailChangeEmail", () => {
  it("mails the NEW address and records it on the token", async () => {
    restoreClock = freezeClock(BASE);
    const { service, rows, sent } = make([user()]);

    await service.sendEmailChangeEmail("user-1", "next@example.test");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "next@example.test", subject: emailChangeEmailSubject });
    expect(sent[0].link).toContain(`${env.APP_URL}/confirm-email-change?token=`);
    expect(rows.verificationTokens[0]).toMatchObject({
      type: "EMAIL_CHANGE",
      newEmail: "next@example.test",
      expiresAt: new Date(BASE + HOUR_MS),
    });
  });
});

describe("confirmEmailChange", () => {
  it("switches the login email, verifies it and forces re-login", async () => {
    const { service, rows, sent } = make([user()]);
    refreshRow(rows, "session-a");
    await service.sendEmailChangeEmail("user-1", "next@example.test");

    await expect(service.confirmEmailChange(rawFrom(sent[0]))).resolves.toEqual({ ok: true });

    expect(rows.users[0]).toMatchObject({ email: "next@example.test", emailVerified: true });
    expect(rows.verificationTokens[0].consumedAt).toBeInstanceOf(Date);
    expect(rows.refreshTokens[0].revokedAt).toBeInstanceOf(Date);
  });

  it("409s when the new address was registered in the meantime", async () => {
    const { service, rows, sent } = make([
      user(),
      user({ id: "user-2", email: "next@example.test" }),
    ]);
    await service.sendEmailChangeEmail("user-1", "next@example.test");

    await expect(service.confirmEmailChange(rawFrom(sent[0]))).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "Email already in use",
    });
    expect(rows.users[0].email).toBe("user@example.test");
  });

  it("rejects a token that carries no new address", async () => {
    const { service, rows } = make([user()]);
    rows.verificationTokens.push(
      tokenRow("bare-raw", { type: "EMAIL_CHANGE", expiresAt: new Date(BASE + HOUR_MS) }),
    );

    await expect(service.confirmEmailChange("bare-raw")).rejects.toMatchObject({
      status: 400,
      message: "Invalid or expired token",
    });
  });
});
