import { isJsonObject } from "./json";
import { describe, expect, it } from "bun:test";

describe("isJsonObject", () => {
  it("accepts objects only - arrays, scalars, and null are all false", () => {
    expect(isJsonObject("{}")).toBe(true);
    expect(isJsonObject('{"a":1}')).toBe(true);
    expect(isJsonObject("[]")).toBe(false);
    expect(isJsonObject('"text"')).toBe(false);
    expect(isJsonObject("42")).toBe(false);
    expect(isJsonObject("true")).toBe(false);
    expect(isJsonObject("null")).toBe(false);
  });

  it("rejects text that does not parse, including empty input", () => {
    expect(isJsonObject("{oops}")).toBe(false);
    expect(isJsonObject('{"a":1,}')).toBe(false);
    expect(isJsonObject("")).toBe(false);
  });
});
