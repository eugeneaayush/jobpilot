import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailoringTransport } from "./codex-transport";
import { sourceFixture } from "./fakes";

export function protocol(
  mode: "valid" | "malformed" | "tool" | "silent" | "disconnect" = "valid",
  provider = "openai",
  rawOutput?: string,
  billing: {
    account?: unknown;
    accountAfterThread?: unknown;
    ordinaryUsageAllowed?: boolean | null;
    openAiConfig?: Record<string, unknown>;
    credits?: unknown;
    userAgent?: string;
  } = {},
) {
  const { proposal } = sourceFixture();
  const messages: Record<string, unknown>[] = [];
  const queue: Record<string, unknown>[] = [];
  let closed = false;
  let threadStarted = false;
  const threadId = "ba1f107a-af54-4b8c-a3b4-6e84dc57c834";
  const transport: TailoringTransport = {
    async send(message) {
      messages.push(message);
      if (mode === "silent") return;
      if (message.method === "initialize")
        queue.push({
          id: message.id,
          result: { userAgent: billing.userAgent ?? "codex-cli/0.154.0-alpha.6.2" },
        });
      if (message.method === "config/read")
        queue.push({
          id: message.id,
          result: {
            config: {
              model_provider: provider,
              model: "saved-model",
              mcp_servers: { unsafe: { command: "never-launched" } },
              ...(billing.openAiConfig && { model_providers: { openai: billing.openAiConfig } }),
            },
          },
        });
      if (message.method === "account/read") {
        let account: unknown = {
          type: "chatgpt",
          planType: "pro",
          email: "private-account-canary@test.invalid",
        };
        if ("account" in billing) account = billing.account;
        if (threadStarted && "accountAfterThread" in billing) account = billing.accountAfterThread;
        queue.push({
          id: message.id,
          result: {
            account,
            requiresOpenaiAuth: true,
          },
        });
      }
      if (message.method === "account/rateLimits/read")
        queue.push({
          id: message.id,
          result: {
            rateLimits: {
              credits:
                "credits" in billing
                  ? billing.credits
                  : { hasCredits: false, unlimited: false, balance: "0" },
            },
            ordinaryUsageAllowed:
              "ordinaryUsageAllowed" in billing ? billing.ordinaryUsageAllowed : true,
          },
        });
      if (message.method === "thread/start") {
        threadStarted = true;
        queue.push({
          id: message.id,
          result: { thread: { id: threadId }, instructionSources: [] },
        });
      }
      if (message.method === "turn/start") {
        queue.push({ id: message.id, result: {} });
        if (mode === "tool")
          queue.push({
            method: "item/started",
            params: { threadId, item: { type: "commandExecution" } },
          });
        queue.push({
          method: "item/completed",
          params: {
            threadId,
            item: {
              type: "agentMessage",
              text:
                rawOutput ??
                (mode === "malformed" ? "{invalid private-canary" : JSON.stringify(proposal)),
            },
          },
        });
        if (mode !== "disconnect")
          queue.push({
            method: "turn/completed",
            params: { threadId, turn: { status: "completed" } },
          });
      }
    },
    async receive() {
      if (mode === "disconnect" && !queue.length) throw new Error("private-transport-error-canary");
      return queue.shift() ?? new Promise(() => {});
    },
    async close() {
      closed = true;
    },
  };
  return { transport, messages, closed: () => closed };
}
export async function temporary(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-tailoring-test-"));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
