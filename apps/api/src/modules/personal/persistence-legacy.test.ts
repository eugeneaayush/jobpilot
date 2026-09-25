import { APPLIED_AT, setup } from "@/modules/campaign/jobs/fakes";
import { afterEach, describe, expect, it } from "bun:test";

const previousMode = process.env.PERSONAL_MODE;
afterEach(() => {
  if (previousMode === undefined) delete process.env.PERSONAL_MODE;
  else process.env.PERSONAL_MODE = previousMode;
});

describe("personal mode legacy submission guards", () => {
  it("rejects legacy PATCH applying and pilot apply claims before their writes", async () => {
    process.env.PERSONAL_MODE = "true";
    const state = setup();
    state.setStatus("approved");
    await expect(state.service.patchJob("u1", "c1", "j1", { status: "applying" })).rejects.toThrow(
      "personal attempt broker",
    );
    await expect(state.service.claimJobForApply("u1", "c1", "j1")).rejects.toThrow(
      "personal attempt broker",
    );
  });
  it("rejects legacy applied results even without an earlier apply claim", async () => {
    process.env.PERSONAL_MODE = "true";
    const state = setup();
    await expect(
      state.service.recordJobResult("u1", "c1", "j1", {
        outcome: "applied",
        appliedAt: APPLIED_AT,
      }),
    ).rejects.toThrow("personal attempt broker");
  });
  it("keeps the nonpersonal claim path working", async () => {
    process.env.PERSONAL_MODE = "false";
    const state = setup();
    state.setStatus("approved");
    expect((await state.service.claimJobForApply("u1", "c1", "j1")).status).toBe("applying");
  });
});
