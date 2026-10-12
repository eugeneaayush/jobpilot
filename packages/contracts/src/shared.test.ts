import { idParam } from "./shared";
import { describe, expect, it } from "bun:test";

const UUID = "3f2c3f1e-0d5c-4f6a-9b8e-1a2b3c4d5e6f";

describe("idParam", () => {
  it("accepts a uuid and passes it through", () => {
    expect(idParam.parse({ id: UUID })).toEqual({ id: UUID });
  });

  it("rejects a non-uuid or missing id, pointing at the id path", () => {
    const bad = idParam.safeParse({ id: "not-a-uuid" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0].path).toEqual(["id"]);
    }
    expect(idParam.safeParse({}).success).toBe(false);
  });
});
