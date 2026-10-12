import { optionalPhoneSchema } from "./phone";
import { describe, expect, it } from "bun:test";

describe("optionalPhoneSchema", () => {
  it("treats empty string, null, and missing as no phone at all", () => {
    expect(optionalPhoneSchema.parse("")).toBe("");
    expect(optionalPhoneSchema.parse(null)).toBe(null);
    expect(optionalPhoneSchema.parse(undefined)).toBe(undefined);
  });

  it("accepts full international numbers", () => {
    expect(optionalPhoneSchema.parse("+14155552671")).toBe("+14155552671");
    expect(optionalPhoneSchema.parse("+442071838750")).toBe("+442071838750");
  });

  it("rejects garbage and numbers missing their country code", () => {
    for (const bad of ["4155552671", "+1415555267", "+999999999", "not-a-phone"]) {
      expect(optionalPhoneSchema.safeParse(bad).success).toBe(false);
    }
  });
});
