import { defineConfig } from "@playwright/test";

/**
 * Synthetic personal-dashboard UI tests only. Everything the spec touches is
 * route-mocked — never point this config at a real environment.
 */
export default defineConfig({
  testDir: "tests/personal-ui",
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
