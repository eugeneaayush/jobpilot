import { fakeUserDelegate } from "./fakes";
import { requireVerifiedEmail } from "./verified.middleware";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const state = { user: null as { id: string; emailVerified: boolean } | null };
let restoreUsers: () => void;
beforeAll(() => {
  restoreUsers = fakeUserDelegate(async () => state.user);
});
afterAll(() => restoreUsers());

describe("requireVerifiedEmail", () => {
  it("passes a verified user", async () => {
    state.user = { id: "user-1", emailVerified: true };

    await expect(requireVerifiedEmail("user-1")).resolves.toBeUndefined();
  });

  it("403s with EMAIL_NOT_VERIFIED for an unverified user", async () => {
    state.user = { id: "user-1", emailVerified: false };

    await expect(requireVerifiedEmail("user-1")).rejects.toMatchObject({
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
  });

  it("fails closed the same way when the user is gone", async () => {
    state.user = null;

    await expect(requireVerifiedEmail("ghost")).rejects.toMatchObject({
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
  });
});
