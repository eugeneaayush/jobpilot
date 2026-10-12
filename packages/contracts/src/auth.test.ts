import {
  ApiTokenCreateSchema,
  ChangeEmailSchema,
  ChangePasswordSchema,
  ConfirmEmailChangeSchema,
  ForgotPasswordSchema,
  LoginSchema,
  OAuthProviderSchema,
  RegisterSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from "./auth";
import { describe, expect, it } from "bun:test";

const STRONG_PASSWORD = "Sup3r$ecret";

describe("LoginSchema", () => {
  it("accepts any non-empty password so pre-policy accounts can still sign in", () => {
    expect(LoginSchema.parse({ email: "user@example.com", password: "x" })).toEqual({
      email: "user@example.com",
      password: "x",
    });
  });

  it("requires a real email and a non-empty password", () => {
    expect(LoginSchema.safeParse({ email: "user@example.com", password: "" }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: "user@example.com" }).success).toBe(false);
  });
});

describe("RegisterSchema", () => {
  it("accepts a password spanning all four character classes", () => {
    expect(RegisterSchema.parse({ email: "user@example.com", password: STRONG_PASSWORD })).toEqual({
      email: "user@example.com",
      password: STRONG_PASSWORD,
    });
  });

  it("rejects a password missing a class or under 8 characters", () => {
    for (const password of ["password1!", "PASSWORD1!", "Password!", "Password1", "Sup3r$e"]) {
      expect(RegisterSchema.safeParse({ email: "user@example.com", password }).success).toBe(false);
    }
  });

  it("requires a real email", () => {
    expect(RegisterSchema.safeParse({ email: "nope", password: STRONG_PASSWORD }).success).toBe(
      false,
    );
  });
});

describe("ApiTokenCreateSchema", () => {
  it("bounds the token name to 1-100 characters", () => {
    expect(ApiTokenCreateSchema.parse({ name: "cli" })).toEqual({ name: "cli" });
    expect(ApiTokenCreateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(ApiTokenCreateSchema.safeParse({ name: "x".repeat(100) }).success).toBe(true);
    expect(ApiTokenCreateSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});

describe("token-carrying schemas", () => {
  it("require a non-empty token", () => {
    for (const schema of [VerifyEmailSchema, ConfirmEmailChangeSchema]) {
      expect(schema.safeParse({ token: "abc123" }).success).toBe(true);
      expect(schema.safeParse({ token: "" }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
    expect(ResetPasswordSchema.safeParse({ token: "", password: STRONG_PASSWORD }).success).toBe(
      false,
    );
  });
});

describe("ForgotPasswordSchema", () => {
  it("takes only an email address", () => {
    expect(ForgotPasswordSchema.parse({ email: "user@example.com" })).toEqual({
      email: "user@example.com",
    });
    expect(ForgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(false);
  });
});

describe("ResetPasswordSchema", () => {
  it("enforces the password policy on the new password", () => {
    expect(
      ResetPasswordSchema.safeParse({ token: "abc123", password: STRONG_PASSWORD }).success,
    ).toBe(true);
    expect(ResetPasswordSchema.safeParse({ token: "abc123", password: "weak" }).success).toBe(
      false,
    );
  });
});

describe("OAuthProviderSchema", () => {
  it("accepts only the two lowercase provider slugs", () => {
    expect(OAuthProviderSchema.safeParse("google").success).toBe(true);
    expect(OAuthProviderSchema.safeParse("github").success).toBe(true);
    expect(OAuthProviderSchema.safeParse("Google").success).toBe(false);
    expect(OAuthProviderSchema.safeParse("gitlab").success).toBe(false);
  });
});

describe("ChangePasswordSchema", () => {
  it("leaves currentPassword optional; the policy applies to newPassword only", () => {
    expect(ChangePasswordSchema.parse({ newPassword: STRONG_PASSWORD })).toEqual({
      newPassword: STRONG_PASSWORD,
    });
    expect(ChangePasswordSchema.safeParse({ newPassword: "weak" }).success).toBe(false);
    expect(ChangePasswordSchema.safeParse({}).success).toBe(false);
  });
});

describe("ChangeEmailSchema", () => {
  it("requires a valid newEmail and lets currentPassword be absent", () => {
    expect(ChangeEmailSchema.parse({ newEmail: "next@example.com" })).toEqual({
      newEmail: "next@example.com",
    });
    expect(ChangeEmailSchema.safeParse({ newEmail: "nope" }).success).toBe(false);
    expect(ChangeEmailSchema.safeParse({}).success).toBe(false);
  });
});
