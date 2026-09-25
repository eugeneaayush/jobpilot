import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const toolNames = [
  "inspect_form",
  "fill_field",
  "upload_resume",
  "upload_attachment",
  "submit_application",
  "reconcile",
];
interface LifecycleRecord {
  capturedAt: string;
  pid: number;
  attemptId: string;
  event: string;
  operation?: string;
  code?: number;
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic MCP lifecycle deadline exceeded")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "broker-mcp-fixture-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dir, "../../../../../plugin/scripts/personal-browser.ts")],
    env: {
      PATH: process.env.PATH ?? "",
      JOBPILOT_API: "http://127.0.0.1:9",
      JOBPILOT_API_TOKEN: "synthetic-token",
      JOBPILOT_ATTEMPT_ID: attemptId,
      JOBPILOT_LEASE_OWNER: "synthetic-owner",
      JOBPILOT_LEASE_GENERATION: "1",
      JOBPILOT_PERSONAL_ROOT: root,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined); // Drain without printing or mixing MCP channels.
  const client = new Client({ name: "synthetic-test", version: "1.0.0" });
  const closed = new Promise<void>((resolve) => {
    client.onclose = resolve;
  });
  return {
    root,
    transport,
    client,
    closed,
    async cleanup() {
      await bounded(client.close());
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function lifecycle(root: string, pid: number) {
  const directory = resolve(root, "diagnostics");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".lifecycle.jsonl"));
  expect(files).toHaveLength(1);
  const file = resolve(directory, files[0]!);
  const raw = await readFile(file, "utf8");
  const records = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LifecycleRecord);
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(
      Object.keys(record).every((key) =>
        ["capturedAt", "pid", "attemptId", "event", "operation", "code"].includes(key),
      ),
    ).toBe(true);
    expect(record.attemptId).toBe(attemptId);
    expect(record.pid).toBe(pid);
    expect(Number.isFinite(Date.parse(record.capturedAt))).toBe(true);
    if (record.operation !== undefined) expect(toolNames).toContain(record.operation);
  }
  expect(raw).not.toContain("synthetic-token");
  expect(raw).not.toContain("synthetic-owner");
  expect(raw).not.toContain(root);
  if (process.platform !== "win32") {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  return { records, raw };
}

test("official MCP stdio persists scoped tool lifecycle and a real stdin close before exit", async () => {
  const f = await fixture();
  try {
    await bounded(f.client.connect(f.transport));
    const pid = f.transport.pid!;
    expect(pid).toBeGreaterThan(0);
    const listed = await bounded(f.client.listTools());
    expect(listed.tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(
      true,
    );
    await bounded(f.client.ping());
    expect(
      (
        await bounded(
          f.client.callTool({ name: "submit_application", arguments: { authorized: true } }),
        )
      ).isError,
    ).toBe(true);
    // A valid scoped call reaches its local API check; the closed synthetic port
    // fails before any browser or employer request can be created.
    expect((await bounded(f.client.callTool({ name: "reconcile", arguments: {} }))).isError).toBe(
      true,
    );
    expect(
      (
        await bounded(
          f.client.callTool({
            name: "evaluate",
            arguments: { code: "synthetic-private-operation-canary" },
          }),
        )
      ).isError,
    ).toBe(true);
    const running = await lifecycle(f.root, pid);
    expect(running.records[0]?.event).toBe("started");
    for (const operation of ["submit_application", "reconcile"])
      expect(
        running.records
          .filter((record) => record.operation === operation)
          .map((record) => record.event),
      ).toEqual(["tool_started", "tool_finished"]);
    expect(running.raw).not.toContain("evaluate");
    expect(running.raw).not.toContain("synthetic-private-operation-canary");

    // The official client ends the real pipe and waits for child closure. Read
    // disk only after that event, proving exit metadata survives process death.
    await bounded(f.client.close());
    await bounded(f.closed);
    const stopped = await lifecycle(f.root, pid);
    expect(stopped.records.some((record) => record.event === "stdin_end")).toBe(true);
    expect(stopped.records.at(-1)).toMatchObject({ event: "exit", code: 0 });
    expect(stopped.records.filter((record) => record.event === "exit")).toHaveLength(1);
    expect(stopped.records.some((record) => record.event === "shutdown_deadline")).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 15_000);

test("server SIGTERM disconnects the official MCP client and durably records graceful exit", async () => {
  if (process.platform === "win32") return;
  const f = await fixture();
  try {
    await bounded(f.client.connect(f.transport));
    await bounded(f.client.ping());
    const pid = f.transport.pid!;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGTERM");
    await bounded(f.closed);
    const stopped = await lifecycle(f.root, pid);
    expect(stopped.records.map((record) => record.event)).toEqual(["started", "sigterm", "exit"]);
    expect(stopped.records.at(-1)?.code).toBe(0);
    expect(f.transport.pid).toBeNull();
  } finally {
    await f.cleanup();
  }
}, 15_000);
