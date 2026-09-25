import { isPrivateOnlyRoute } from "./privacy";
import { describe, expect, it } from "bun:test";

describe("personal privacy route gate", () => {
  it("blocks every public resume, portfolio and activity route", () => {
    for (const path of [
      "/api/public/resumes/a/pdf",
      "/api/public/portfolio/a",
      "/api/public/jobs",
      "/api/promotion",
    ]) {
      expect(isPrivateOnlyRoute(path)).toBe(true);
    }
  });
  it("retains authenticated personal and resume routes", () => {
    expect(isPrivateOnlyRoute("/api/resumes/a/pdf")).toBe(false);
    expect(isPrivateOnlyRoute("/api/personal")).toBe(false);
  });
});
