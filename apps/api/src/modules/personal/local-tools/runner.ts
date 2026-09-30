import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PersonalLocalToolsRequest,
  type PersonalLocalToolsResponse,
  personalLocalToolsRequestSchema,
  personalLocalToolsResponseSchema,
} from "@jobpilot/contracts/personal-local-tools";
import { privateArtifactRoot, readPrivateArtifact } from "../persistence-policy";

type Operation = PersonalLocalToolsRequest["operation"];
type Input<O extends Operation> = Extract<PersonalLocalToolsRequest, { operation: O }>;
type Result<O extends Operation> = Extract<
  PersonalLocalToolsResponse,
  { operation: O; status: "ok" }
>["result"];
const TIMEOUTS: Record<Operation, number> = {
  capabilities: 10_000,
  discover_jobs: 120_000,
  render_resume: 90_000,
  verify_document: 30_000,
  export_resume_yaml: 30_000,
  import_resume_yaml: 30_000,
};
const FILE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_OUTPUT = 2_000_000;
const MAX_ARTIFACT = 16_000_000;
interface RunOptions {
  signal?: AbortSignal;
  inputFiles?: Record<string, Uint8Array>;
}
interface ExecutionOptions extends RunOptions {
  root: string;
  executable: string;
  timeoutMs?: number;
}

export function localToolsPython() {
  const executable =
    process.env.JOBPILOT_LOCAL_TOOLS_PYTHON ??
    path.resolve(
      import.meta.dir,
      "../../../../../../services/local-tools/.venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  if (!path.isAbsolute(executable)) throw new Error("Local tools interpreter must be absolute");
  return executable;
}

function childResponse(
  request: PersonalLocalToolsRequest,
  directory: string,
  options: ExecutionOptions,
): Promise<Buffer> {
  const commandPaths = ["pdftotext", "pdftoppm"]
    .map((name) => Bun.which(name))
    .filter((value): value is string => !!value)
    .map((value) => path.dirname(value));
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, ["-m", "jobpilot_local_tools"], {
      cwd: directory,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: [
          ...new Set([path.dirname(options.executable), ...commandPaths, "/usr/bin", "/bin"]),
        ].join(path.delimiter),
        HOME: directory,
        TMPDIR: directory,
        XDG_CACHE_HOME: directory,
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
        LANG: "en_US.UTF-8",
        NODE_ENV: "production",
        ...(process.platform === "win32" && {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        }),
      },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: Error | undefined;
    let stopped = false;
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (stopped) return;
      stopped = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else if (child.pid) {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        // Killing only Python would leave a Typst/Poppler child running on Windows.
        const killer = spawn(
          path.join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true,
            env: { SystemRoot: systemRoot, NODE_ENV: "production" },
          },
        );
        killer.on("error", () => child.kill("SIGKILL"));
      } else child.kill("SIGKILL");
    };
    const cancel = () => stop("Local tool cancelled");
    const timer = setTimeout(
      () => stop("Local tool exceeded its deadline"),
      options.timeoutMs ?? TIMEOUTS[request.operation],
    );
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdout.on("data", (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > MAX_OUTPUT) stop("Local tool output exceeds bound");
      else chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      errorBytes += data.length;
      if (errorBytes > MAX_OUTPUT) stop("Local tool diagnostics exceed bound");
    });
    child.stdin.on("error", () => stop("Local tool input was interrupted"));
    child.on("error", () => {
      failure = new Error("Local tools are unavailable; run personal:tools:setup");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (failure || code !== 0) reject(failure ?? new Error("Local tool execution failed"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function executeLocalTool<O extends Operation>(
  request: Input<O>,
  options: ExecutionOptions,
): Promise<{ result: Result<O>; artifacts: Record<string, Buffer> }> {
  const input = personalLocalToolsRequestSchema.parse(request);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_OUTPUT)
    throw new Error("Local tool input exceeds bound");
  if (options.signal?.aborted) throw new Error("Local tool cancelled");
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(options.root, "operation-"));
  await chmod(directory, 0o700);
  try {
    let inputBytes = 0;
    for (const [filename, bytes] of Object.entries(options.inputFiles ?? {})) {
      inputBytes += bytes.byteLength;
      if (!FILE.test(filename) || bytes.byteLength > MAX_ARTIFACT || inputBytes > 32_000_000)
        throw new Error("Local tool input artifact is invalid");
      await writeFile(path.join(directory, filename), bytes, { mode: 0o600, flag: "wx" });
    }
    const response = personalLocalToolsResponseSchema.parse(
      JSON.parse((await childResponse(input, directory, options)).toString("utf8")),
    );
    if (response.requestId !== input.requestId || response.operation !== input.operation)
      throw new Error("Local tool response identity mismatch");
    if (response.status === "error") throw new Error(`Local tool failed (${response.error.code})`);
    const artifacts: Record<string, Buffer> = {};
    const files: string[] = [];
    if (response.operation === "render_resume")
      files.push(response.result.filename, response.result.mappingFilename);
    if (response.operation === "discover_jobs" && response.result.snapshotFilename)
      files.push(response.result.snapshotFilename);
    let artifactBytes = 0;
    for (const filename of files) {
      const bytes = await readPrivateArtifact(path.join(directory, filename), directory);
      artifactBytes += bytes.length;
      if (bytes.length > MAX_ARTIFACT || artifactBytes > 32_000_000)
        throw new Error("Local tool artifact exceeds bound");
      artifacts[filename] = bytes;
    }
    if (response.operation === "render_resume") {
      const bytes = artifacts[response.result.filename];
      if (
        bytes.length !== response.result.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== response.result.sha256
      )
        throw new Error("Local tool PDF hash mismatch");
    }
    if (response.operation === "discover_jobs" && response.result.snapshotFilename) {
      const bytes = artifacts[response.result.snapshotFilename];
      if (
        bytes.length > MAX_OUTPUT ||
        createHash("sha256").update(bytes).digest("hex") !== response.result.responseSha256
      )
        throw new Error("Local tool snapshot hash mismatch");
    }
    return { result: response.result as Result<O>, artifacts };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function runLocalTool<O extends Operation>(
  userId: string,
  operation: O,
  payload: Input<O>["payload"],
  options: RunOptions = {},
) {
  const request = personalLocalToolsRequestSchema.parse({
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    operation,
    payload,
  });
  return executeLocalTool(request as Input<O>, {
    ...options,
    root: path.join(privateArtifactRoot(userId), "local-tools"),
    executable: localToolsPython(),
  });
}
