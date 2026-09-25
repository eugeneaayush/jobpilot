import { readFile } from "node:fs/promises";
import { runCodexTailoring } from "./codex";
import { protocol, temporary } from "./codex-test-fixtures";
import { sourceFixture } from "./fakes";
import { expect, test } from "bun:test";

for (const [credits, code] of [
  [{ hasCredits: true, unlimited: false, balance: "5" }, "paid_credit_balance_present"],
  [{ hasCredits: false, unlimited: true, balance: "0" }, "paid_credit_balance_present"],
  [{ hasCredits: false, unlimited: false, balance: "1" }, "paid_credit_guard_unavailable"],
  [{ hasCredits: false, unlimited: false }, "paid_credit_guard_unavailable"],
  [null, "paid_credit_guard_unavailable"],
] as const)
  test(`${code} prevents a model turn despite ordinary usage permission`, async () =>
    temporary(async (root) => {
      const fake = protocol("valid", "openai", undefined, { credits });
      const result = await runCodexTailoring(sourceFixture().input, {
        runtimeDir: root,
        privateRoot: root,
        approval: { provider: "openai", allowApplicantData: true },
        transport: async () => fake.transport,
      });
      expect(result).toMatchObject({ status: "blocked", diagnostic: { code } });
      expect(fake.messages.some((message) => message.method === "turn/start")).toBe(false);
      expect(JSON.stringify(result)).not.toContain('"balance"');
    }));

test("account drift during thread setup blocks the turn without changing saved authentication", async () =>
  temporary(async (root) => {
    const fake = protocol("valid", "openai", undefined, {
      accountAfterThread: { type: "apiKey" },
    });
    const result = await runCodexTailoring(sourceFixture().input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result).toMatchObject({
      status: "blocked",
      providerMode: "api_key",
      diagnostic: { phase: "subscription_verification", code: "subscription_setup" },
    });
    expect(fake.messages.some((message) => message.method === "thread/start")).toBe(true);
    expect(fake.messages.some((message) => message.method === "turn/start")).toBe(false);
    expect(fake.messages.some((message) => /login|logout/.test(String(message.method)))).toBe(
      false,
    );
  }));

for (const [account, providerMode] of [
  [{ type: "apiKey" }, "api_key"],
  [{ type: "chatgpt", planType: "self_serve_business_usage_based" }, "usage_based"],
  [{ type: "chatgpt", planType: "unknown" }, "unknown"],
  [null, "unknown"],
] as const)
  test(`unverified or metered ${providerMode} account cannot receive professional input`, async () =>
    temporary(async (root) => {
      const fake = protocol("valid", "openai", undefined, { account });
      const result = await runCodexTailoring(sourceFixture().input, {
        runtimeDir: root,
        privateRoot: root,
        approval: { provider: "openai", allowApplicantData: true },
        transport: async () => fake.transport,
      });
      expect(result).toMatchObject({
        status: "blocked",
        providerMode,
        diagnostic: { phase: "subscription_verification", code: "subscription_setup" },
      });
      expect(fake.messages.some((message) => message.method === "thread/start")).toBe(false);
      expect(fake.messages.some((message) => message.method === "turn/start")).toBe(false);
      expect(JSON.stringify(fake.messages)).not.toContain(sourceFixture().input.job.description);
      expect(fake.closed()).toBe(true);
    }));

for (const ordinaryUsageAllowed of [false, null] as const)
  test(`ordinary included usage ${ordinaryUsageAllowed} holds without paid fallback`, async () =>
    temporary(async (root) => {
      const fake = protocol("valid", "openai", undefined, { ordinaryUsageAllowed });
      const result = await runCodexTailoring(sourceFixture().input, {
        runtimeDir: root,
        privateRoot: root,
        approval: { provider: "openai", allowApplicantData: true },
        transport: async () => fake.transport,
      });
      expect(result).toMatchObject({
        status: "blocked",
        providerMode: "chatgpt_subscription",
        diagnostic: {
          phase: "included_usage_verification",
          code:
            ordinaryUsageAllowed === false
              ? "ordinary_usage_unavailable"
              : "ordinary_usage_unknown",
        },
      });
      expect(fake.messages.some((message) => message.method === "turn/start")).toBe(false);
      expect(fake.messages.some((message) => message.method === "account/login/start")).toBe(false);
      expect(fake.closed()).toBe(true);
    }));

test("saved API provider credential overrides cannot borrow a ChatGPT account's budget proof", async () =>
  temporary(async (root) => {
    const fake = protocol("valid", "openai", undefined, {
      openAiConfig: { base_url: "https://api.openai.com/v1", env_key: "PRIVATE_KEY_CANARY" },
    });
    const result = await runCodexTailoring(sourceFixture().input, {
      runtimeDir: root,
      privateRoot: root,
      approval: { provider: "openai", allowApplicantData: true },
      transport: async () => fake.transport,
    });
    expect(result).toMatchObject({
      status: "blocked",
      diagnostic: { phase: "subscription_verification", code: "subscription_setup" },
    });
    expect(fake.messages.some((message) => message.method === "turn/start")).toBe(false);
    expect(await readFile(result.artifactPath!, "utf8")).not.toContain("PRIVATE_KEY_CANARY");
  }));
