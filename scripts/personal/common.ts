import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PilotDiscoveryConfig } from "./pilot-discovery";

export const repository = path.resolve(import.meta.dir, "../..");
export const runtimeRoot = path.resolve(
  process.env.JOBPILOT_PERSONAL_ROOT ??
    path.join(os.homedir(), "Library/Application Support/JobPilotPersonal"),
);
export const postgresBin =
  process.env.JOBPILOT_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
export const dotnet = process.env.JOBPILOT_DOTNET ?? path.join(runtimeRoot, "tools/dotnet/dotnet");

export interface RuntimeConfig {
  pilotDiscovery?: PilotDiscoveryConfig;
  apiEnv: Record<string, string>;
  sourceJsonPath: string;
  sourceDocxPath: string;
  comparisonPaths: string[];
  candidate: Record<string, unknown>;
  syntheticApplicant?: boolean;
  providerApproval?: {
    verified: boolean;
    allowMetadataOnly?: boolean;
    allowApplicantData: boolean;
    provider: string;
  };
  boardToken: string;
  account: { email: string; password: string; token?: string; userId?: string };
}
export async function privateWrite(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}
export async function readConfig(): Promise<RuntimeConfig> {
  return JSON.parse(await readFile(path.join(runtimeRoot, "runtime.json"), "utf8"));
}
export async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? repository,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${path.basename(command[0])} failed (${exitCode}): ${stderr.slice(-2500)}`);
  if (!options.quiet && stdout.trim()) console.log(stdout.trim());
  return stdout;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  let milliseconds: number;
  if (/^\d+$/.test(text)) milliseconds = Number(text) * 1000;
  else if (
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)
  )
    milliseconds = Date.parse(text) - now;
  else return undefined;
  return Number.isFinite(milliseconds) &&
    Number.isSafeInteger(now + Math.max(0, milliseconds)) &&
    now + Math.max(0, milliseconds) <= 8.64e15
    ? Math.max(0, milliseconds)
    : undefined;
}

export class LocalHttpError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly retryAt: number | undefined;
  constructor(
    readonly status: number,
    readonly service: "api" | "terminal",
    readonly route: string,
    readonly method: string,
    retryAfter: string | null,
    readonly retryScope?: string | null,
  ) {
    super(`${route.split("?")[0]}: HTTP ${status}; inspect the private dashboard for details`);
    const now = Date.now();
    this.retryAfterMs = retryAfterMilliseconds(retryAfter, now);
    this.retryAt = this.retryAfterMs === undefined ? undefined : now + this.retryAfterMs;
  }
}

export async function apiRequest(
  config: RuntimeConfig,
  route: string,
  body?: unknown,
  method?: string,
): Promise<unknown> {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(`http://localhost:4101/api${route}`, {
    method: verb,
    headers: {
      "content-type": "application/json",
      ...(config.account.token ? { authorization: `Bearer ${config.account.token}` } : {}),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(
      verb === "POST" && /^\/personal\/[^/]+\/(tailoring|preparation)$/.test(route)
        ? 7 * 60_000
        : 120_000,
    ),
  });
  if (!response.ok)
    throw new LocalHttpError(
      response.status,
      "api",
      route,
      verb,
      response.headers.get("retry-after"),
      response.headers.get("x-jobpilot-retry-scope"),
    );
  return response.json();
}
