import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface TailoringTransport {
  send(message: Record<string, unknown>): Promise<void>;
  receive(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export const disabledTailoringFeatures = [
  "apps",
  "plugins",
  "remote_plugin",
  "hooks",
  "memories",
  "chronicle",
  "multi_agent",
  "multi_agent_v2",
  "shell_tool",
  "unified_exec",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "workspace_dependencies",
  "tool_suggest",
  "skill_search",
  "in_app_local_automation",
  "view_image",
  "goals",
  "code_mode",
  "code_mode_host",
];
export function tailoringEnvironment(original: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...original };
  for (const name of Object.keys(environment))
    if (
      /^(?:JOBPILOT_|DATABASE_|JWT_|SECRET_|PERSONAL_|OPENAI_API_KEY$|CODEX_API_KEY$|PG(?:HOST|PORT|USER|PASSWORD|DATABASE|PASSFILE|SERVICEFILE|SERVICE)$|STORAGE_ROOT$|APP_URL$|CORS_ORIGINS$)/i.test(
        name,
      )
    )
      delete environment[name];
  return environment;
}
export function officialOpenAiConfiguration(
  config: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (
    config.model_provider !== undefined &&
    config.model_provider !== null &&
    config.model_provider !== "openai"
  )
    return false;
  const providers = config.model_providers as Record<string, Record<string, unknown>> | undefined;
  const official = (value: unknown) => {
    if (value === undefined || value === null || value === "") return true;
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        ["api.openai.com", "chatgpt.com"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === "443")
      );
    } catch {
      return false;
    }
  };
  return (
    official(providers?.openai?.base_url) &&
    official(config.chatgpt_base_url) &&
    official(environment.OPENAI_BASE_URL)
  );
}
export async function startTailoringTransport(
  directory: string,
  privateRoot: string,
): Promise<TailoringTransport> {
  const found = Bun.which("codex");
  if (process.platform !== "darwin" || !found || !Bun.which("sandbox-exec"))
    throw new Error("Verified Codex app-server isolation is unavailable");
  const executable = await realpath(found);
  const codexHome = await realpath(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const quote = (value: string) => JSON.stringify(value);
  const profile = `(version 1)(allow default)(deny file-read-data (require-all (subpath ${quote(privateRoot)}) (require-not (subpath ${quote(directory)}))))(deny file-read* (literal ${quote(join(codexHome, "AGENTS.md"))}) (literal ${quote(join(codexHome, "AGENTS.override.md"))}) (subpath ${quote(join(codexHome, "memories"))}))(deny process-exec (require-not (literal ${quote(executable)})))`;
  const args = [
    "-p",
    profile,
    executable,
    "app-server",
    "--stdio",
    ...disabledTailoringFeatures.flatMap((feature) => ["--disable", feature]),
    "-c",
    "notify=[]",
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
  ];
  const child = spawn("/usr/bin/sandbox-exec", args, {
    cwd: directory,
    env: tailoringEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let bytes = 0;
  let failed = false;
  child.stdin.on("error", () => {
    failed = true;
  });
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      failed = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", count);
  child.stderr.on("data", count);
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      failed = true;
      exited = true;
      resolve();
    });
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async send(message) {
      if (failed || exited) throw new Error("Codex transport closed");
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
          error ? reject(new Error("Codex input failed")) : resolve(),
        ),
      );
    },
    async receive() {
      const line = await iterator.next();
      if (failed || line.done || line.value.length > 1024 * 1024)
        throw new Error("Codex output unavailable or exceeded its bound");
      const value: unknown = JSON.parse(line.value);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Codex event");
      return value as Record<string, unknown>;
    },
    async close() {
      child.stdin.end();
      if (!exited) {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exit,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 10_000);
          }),
        ]);
        clearTimeout(timer);
      }
      // Always reap the isolated process group, including any child surviving its leader.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        if (!exited) child.kill("SIGKILL");
      }
      lines.close();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}
