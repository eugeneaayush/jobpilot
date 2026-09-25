import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCodexTailoring } from "./codex";
import { protocol, temporary } from "./codex-test-fixtures";
import { officialOpenAiConfiguration, tailoringEnvironment } from "./codex-transport";
import { sourceFixture } from "./fakes";
import { expect, test } from "bun:test";

test("synthetic app-server exchange sends only supplied facts with tools disabled and preserves saved model", async () =>
  temporary(async (root) => {
    const { input } = sourceFixture();
    const fake = protocol();
    const result = await runCodexTailoring(input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result.status).toBe("proposed");
    expect(result.providerMode).toBe("chatgpt_subscription");
    expect(fake.closed()).toBe(true);
    expect((await stat(result.artifactPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(result.artifactPath!))).mode & 0o777).toBe(0o700);
    const start = fake.messages.find((item) => item.method === "thread/start")!.params as Record<
      string,
      unknown
    >;
    expect(start.model).toBeUndefined();
    expect(start.modelProvider).toBeUndefined();
    expect(start.dynamicTools).toEqual([]);
    expect(start.ephemeral).toBe(true);
    expect(start.approvalPolicy).toBe("never");
    expect(start.config).toMatchObject({
      mcp_servers: { unsafe: { enabled: false } },
      features: {
        shell_tool: false,
        plugins: false,
        hooks: false,
        browser_use: false,
        memories: false,
      },
      web_search: "disabled",
    });
    const turn = fake.messages.find((item) => item.method === "turn/start")!.params as {
      input: { text: string }[];
    };
    expect(turn.input[0]!.text).toContain(input.job.description);
    expect(turn.input[0]!.text).not.toContain("synthetic@example.test");
    expect(fake.messages.find((item) => item.method === "account/read")?.params).toEqual({
      refreshToken: false,
    });
    expect(fake.messages.filter((item) => item.method === "account/read")).toHaveLength(2);
    expect(start.config).not.toHaveProperty("forced_login_method");
    expect(JSON.stringify(result)).not.toContain("private-account-canary");
    expect(
      await readFile(join(dirname(result.artifactPath!), "diagnostic.json"), "utf8"),
    ).not.toContain("private-account-canary");
  }));

for (const mode of ["malformed", "tool"] as const)
  test(`${mode} output fails closed without logging raw model text`, async () =>
    temporary(async (root) => {
      const fake = protocol(mode);
      const result = await runCodexTailoring(sourceFixture().input, {
        runtimeDir: root,
        privateRoot: root,
        approval: { provider: "openai", allowApplicantData: true },
        transport: async () => fake.transport,
      });
      expect(result.status).toBe("blocked");
      expect(fake.closed()).toBe(true);
      expect(await readFile(result.artifactPath!, "utf8")).not.toContain("private-canary");
      if (mode === "malformed") {
        expect(result).toMatchObject({
          diagnostic: { phase: "proposal_parse", code: "proposal_json_invalid" },
        });
        const run = dirname(result.artifactPath!);
        expect(await readFile(join(run, "raw-proposal.txt"), "utf8")).toBe(
          "{invalid private-canary",
        );
        expect(await readFile(join(run, "diagnostic.json"), "utf8")).not.toContain(
          "private-canary",
        );
      } else {
        expect(result).toMatchObject({
          diagnostic: { phase: "proposal_generation", code: "unexpected_tool_activity" },
        });
      }
    }));

test("grounding rejection retains bounded raw proposal privately without returning it as validated", async () =>
  temporary(async (root) => {
    const { input, proposal } = sourceFixture();
    proposal.rewrites[0]!.text = "Built SQL reporting for a $99M portfolio";
    const raw = JSON.stringify(proposal);
    const fake = protocol("valid", "openai", raw);
    const result = await runCodexTailoring(input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result).toMatchObject({
      status: "blocked",
      diagnostic: { phase: "proposal_validation", code: "proposal_validation_failed" },
    });
    expect(JSON.stringify(result)).not.toContain("$99M");
    const run = dirname(result.artifactPath!);
    const path = join(run, "raw-proposal.txt");
    expect(await readFile(path, "utf8")).toBe(raw);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const diagnostic = JSON.parse(await readFile(join(run, "diagnostic.json"), "utf8"));
    expect(diagnostic).toMatchObject({
      schemaVersion: 1,
      phase: "proposal_validation",
      code: "proposal_validation_failed",
      rawProposal: { captured: true, truncated: false, bytes: Buffer.byteLength(raw) },
    });
    expect(diagnostic.rawProposal.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(run, "diagnostic.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(diagnostic)).not.toContain("$99M");
    expect(fake.closed()).toBe(true);
  }));

test("oversized Unicode proposal is capped by bytes and never passed to validation", async () =>
  temporary(async (root) => {
    const fake = protocol("valid", "openai", "é".repeat(50_001));
    const result = await runCodexTailoring(sourceFixture().input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result).toMatchObject({
      status: "blocked",
      diagnostic: { phase: "proposal_capture", code: "proposal_too_large" },
    });
    const run = dirname(result.artifactPath!);
    expect((await stat(join(run, "raw-proposal.txt"))).size).toBe(100_000);
    expect(JSON.parse(await readFile(join(run, "diagnostic.json"), "utf8"))).toMatchObject({
      rawProposal: { captured: true, truncated: true, bytes: 100_000 },
    });
  }));

test("transport failure after agent output keeps private evidence with only a fixed public diagnostic", async () =>
  temporary(async (root) => {
    const fake = protocol("disconnect");
    const result = await runCodexTailoring(sourceFixture().input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result).toMatchObject({
      status: "blocked",
      diagnostic: { phase: "proposal_generation", code: "protocol_failed" },
    });
    const run = dirname(result.artifactPath!);
    expect(JSON.parse(await readFile(join(run, "raw-proposal.txt"), "utf8"))).toEqual(
      sourceFixture().proposal,
    );
    expect(await readFile(join(run, "diagnostic.json"), "utf8")).not.toContain("canary");
    expect(await readFile(result.artifactPath!, "utf8")).not.toContain("canary");
    expect(fake.closed()).toBe(true);
  }));

test("saved foreign provider is blocked before any professional input turn", async () =>
  temporary(async (root) => {
    const fake = protocol("valid", "custom-provider");
    const result = await runCodexTailoring(sourceFixture().input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result.status).toBe("blocked");
    expect(
      fake.messages.some((item) => item.method === "turn/start" || item.method === "thread/start"),
    ).toBe(false);
    expect(fake.closed()).toBe(true);
  }));

test("deadline closes a stalled adapter and cancellation remains distinct", async () =>
  temporary(async (root) => {
    const fake = protocol("silent");
    const options = {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai" as const, allowApplicantData: true as const },
      transport: async () => fake.transport,
    };
    const expired = await runCodexTailoring(sourceFixture().input, { ...options, timeoutMs: 10 });
    expect(expired.status).toBe("timed_out");
    expect(fake.closed()).toBe(true);
    const controller = new AbortController();
    const cancelledTransport = protocol("silent");
    const pending = runCodexTailoring(sourceFixture().input, {
      ...options,
      transport: async () => cancelledTransport.transport,
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 10);
    const cancelled = await pending;
    clearTimeout(timer);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelledTransport.closed()).toBe(true);
  }));

test("provider metadata and subprocess environment reject custom endpoint and application credentials", () => {
  expect(officialOpenAiConfiguration({}, {})).toBe(true);
  expect(
    officialOpenAiConfiguration(
      {
        model_provider: "openai",
        model_providers: { openai: { base_url: "https://api.openai.com/v1" } },
      },
      {},
    ),
  ).toBe(true);
  expect(
    officialOpenAiConfiguration(
      { model_providers: { openai: { base_url: "https://elsewhere.example/v1" } } },
      {},
    ),
  ).toBe(false);
  expect(
    officialOpenAiConfiguration({}, { OPENAI_BASE_URL: "https://api.openai.com.evil.example/v1" }),
  ).toBe(false);
  const env = tailoringEnvironment({
    PATH: "/synthetic",
    OPENAI_API_KEY: "provider-only",
    CODEX_API_KEY: "provider-only",
    JOBPILOT_API_TOKEN: "secret",
    DATABASE_URL: "secret",
    JWT_SECRET: "secret",
    PERSONAL_ROOT: "secret",
    SECRET_MASTER_KEY: "secret",
    PGPASSFILE: "secret",
  });
  expect(env).toEqual({ PATH: "/synthetic" });
});
