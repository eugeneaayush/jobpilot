import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { brokerErrorForModel, PersonalBrowserBroker } from "./personal-browser/core";
import { runHandoff } from "./personal-browser/handoff";
import { createBrokerLifecycle } from "./personal-browser/lifecycle";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const config = {
  api: required("JOBPILOT_API"),
  token: required("JOBPILOT_API_TOKEN"),
  attemptId: required("JOBPILOT_ATTEMPT_ID"),
  leaseOwner: required("JOBPILOT_LEASE_OWNER"),
  leaseGeneration: Number(required("JOBPILOT_LEASE_GENERATION")),
  root: required("JOBPILOT_PERSONAL_ROOT"),
};
async function runBroker() {
  const broker = new PersonalBrowserBroker(config);
  const lifecycle = await createBrokerLifecycle(config);
  lifecycle.record("started");
  let activeOperation: Parameters<typeof lifecycle.record>[1];
  const server = new Server(
    { name: "jobpilot-personal-browser", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const empty = { type: "object" as const, properties: {}, additionalProperties: false };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "inspect_form",
        description:
          "Inspect only the authorized job form. Returns opaque field refs, answerKey when an exact approved answer exists, and resumeUpload. Fill using that answerKey, upload when resumeUpload, park if needsAnswer. No applicant values or page text leave the local broker. Live inspection contacts the employer; offline mode refuses browser access.",
        inputSchema: empty,
      },
      {
        name: "fill_field",
        description:
          "Fill an observed field using only its exact immutable manifest answer. May transmit data in live modes.",
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string" }, answerKey: { type: "string" } },
          required: ["ref", "answerKey"],
          additionalProperties: false,
        },
      },
      {
        name: "upload_resume",
        description:
          "Upload only the hash-verified private manifest resume to the observed resume field. May transmit data.",
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
          additionalProperties: false,
        },
      },
      {
        name: "upload_attachment",
        description:
          "Upload the exact frozen document identified by the observed field's opaque attachmentKey. Only hash-verified private artifacts are permitted; live modes transmit the file.",
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string" }, attachmentKey: { type: "string" } },
          required: ["ref", "attachmentKey"],
          additionalProperties: false,
        },
      },
      {
        name: "submit_application",
        description:
          "Submit once only after the API grants the final permit. No arguments or authorization overrides accepted.",
        inputSchema: empty,
      },
      {
        name: "reconcile",
        description:
          "Reconcile an unresolved submission using actual observed employer confirmation; never clicks submit again.",
        inputSchema: empty,
      },
    ],
  }));
  let work = Promise.resolve();
  let shuttingDown = false;
  let transportDiagnostic: Promise<void> | undefined;
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (shuttingDown)
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Broker is closing; no action was started." }],
      };
    const result = work.then(async () => {
      const operation = request.params.name;
      activeOperation =
        operation === "inspect_form" ||
        operation === "fill_field" ||
        operation === "upload_resume" ||
        operation === "upload_attachment" ||
        operation === "submit_application" ||
        operation === "reconcile"
          ? operation
          : undefined;
      lifecycle.record("tool_started", activeOperation);
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                await broker.call(request.params.name, request.params.arguments ?? {}),
              ),
            },
          ],
        };
      } catch (error) {
        await broker.diagnose(request.params.name, error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: brokerErrorForModel(error),
            },
          ],
        };
      } finally {
        lifecycle.record("tool_finished", activeOperation);
        activeOperation = undefined;
      }
    });
    work = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= work.then(async () => {
      await broker.close();
      await server.close();
    });
    return closing;
  };
  const shutdown = (
    event: "stdin_end" | "sigint" | "sigterm" | "transport_closed" | "uncaught" | "rejection",
    error?: unknown,
  ) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.record(event, activeOperation);
    const fatalDiagnostic =
      error !== undefined ? broker.diagnose("broker_fatal", error) : undefined;
    const deadline = setTimeout(() => {
      lifecycle.record("shutdown_deadline", activeOperation);
      process.exit(1);
    }, 10_000);
    // Flush redacted fatal evidence too; the shared deadline bounds filesystem failure.
    void Promise.all([close(), fatalDiagnostic, transportDiagnostic]).then(
      () => {
        clearTimeout(deadline);
        process.exit(error === undefined ? 0 : 1);
      },
      () => {
        clearTimeout(deadline);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("sigint"));
  process.once("SIGTERM", () => shutdown("sigterm"));
  process.stdin.once("end", () => shutdown("stdin_end"));
  process.once("uncaughtException", (error) => shutdown("uncaught", error));
  process.once("unhandledRejection", (error) => shutdown("rejection", error));
  process.once("exit", (code) => {
    lifecycle.record("exit", activeOperation, code);
    lifecycle.close();
  });
  server.onclose = () => shutdown("transport_closed");
  server.onerror = (error) => {
    lifecycle.record("transport_error", activeOperation);
    transportDiagnostic = broker.diagnose("mcp_transport", error);
  };
  await server.connect(new StdioServerTransport());
}
if (process.argv.includes("--handoff")) await runHandoff(config, required("JOBPILOT_HANDOFF_ID"));
else await runBroker();
