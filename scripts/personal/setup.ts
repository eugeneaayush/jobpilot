import { existsSync } from "node:fs";
import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import {
  dotnet,
  postgresBin,
  privateWrite,
  type RuntimeConfig,
  readConfig,
  repository,
  run,
  runtimeRoot,
} from "./common";
import { syntheticSources } from "./synthetic";

export async function doctor(): Promise<string[]> {
  const missing: string[] = [];
  for (const [name, executable] of [
    ["PostgreSQL 17", path.join(postgresBin, "initdb")],
    [".NET 10", dotnet],
    ["Claude Code", Bun.which("claude")],
    ["Codex", Bun.which("codex")],
    ["Poppler PDF renderer (pdftoppm)", Bun.which("pdftoppm")],
    ["Poppler PDF text extraction (pdftotext)", Bun.which("pdftotext")],
  ]) {
    if (!executable || !existsSync(executable)) missing.push(`${name} unavailable`);
  }
  if (!existsSync(path.join(runtimeRoot, "runtime.json")))
    missing.push("Private runtime not configured; run personal:setup");
  if (!existsSync(chromium.executablePath()))
    missing.push("Chromium unavailable; run bunx playwright install chromium");
  let provider = "Unverified saved CLI configuration";
  let readiness: Record<string, unknown> | null = null;
  if (existsSync(path.join(runtimeRoot, "runtime.json"))) {
    const config = await readConfig();
    for (const source of [config.sourceJsonPath, config.sourceDocxPath])
      if (!existsSync(source)) missing.push("A configured resume source is missing");
    if (
      (await stat(runtimeRoot)).mode & 0o077 ||
      (await stat(path.join(runtimeRoot, "runtime.json"))).mode & 0o077
    )
      missing.push("Runtime permissions must be directory0700 and config0600");
    if (!config.account.token)
      missing.push("Private API account token is missing; rerun personal:setup");
    provider = config.providerApproval?.provider ?? provider;
    if (config.account.token) {
      try {
        const response = await fetch("http://127.0.0.1:4101/api/personal/readiness", {
          headers: { authorization: `Bearer ${config.account.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) throw new Error("Readiness request failed");
        const current = (await response.json()) as {
          blockers?: unknown;
          campaignExecutionReady?: boolean;
          terminal?: { status?: string; codexSupervisorEnabled?: boolean };
          browser?: { status?: string };
          providerApproval?: { scope?: string };
        };
        if (
          !Array.isArray(current.blockers) ||
          current.blockers.some((item) => typeof item !== "string")
        )
          throw new Error("Invalid readiness response");
        missing.push(...current.blockers);
        readiness = {
          campaignExecutionReady: current.campaignExecutionReady === true,
          terminalStatus: current.terminal?.status,
          supervisorEnabled: current.terminal?.codexSupervisorEnabled === true,
          browserStatus: current.browser?.status,
          providerScope: current.providerApproval?.scope,
        };
      } catch {
        missing.push(
          "Live setup verification is unavailable; start personal:dev and rerun personal:doctor",
        );
      }
    }
  }
  const versions: Record<string, string> = { bun: Bun.version };
  for (const [name, command] of [
    ["codex", Bun.which("codex")],
    ["claude", Bun.which("claude")],
    ["dotnet", dotnet],
  ] as const)
    if (command && existsSync(command))
      versions[name] = (await run([command, "--version"], { quiet: true })).trim();
  console.log(
    JSON.stringify(
      {
        runtimeRoot,
        versions,
        provider,
        readiness,
        missing: [...new Set(missing)],
        defaults: "Stopped campaigns; offline preview; no recruiter sends",
        realSubmissionsDuringTests: false,
      },
      null,
      2,
    ),
  );
  return missing;
}

export async function ensureDatabase(config: RuntimeConfig): Promise<void> {
  const databaseDir = path.join(runtimeRoot, "postgres");
  const socketDir = path.join(runtimeRoot, "postgres-socket");
  const databaseUrl = new URL(config.apiEnv.DATABASE_URL);
  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
    const portCheck = Bun.spawn(
      [path.join(postgresBin, "pg_isready"), "-h", "127.0.0.1", "-p", databaseUrl.port],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await portCheck.exited) === 0)
      throw new Error(
        "Database port is occupied by another cluster; set JOBPILOT_POSTGRES_PORT before setup",
      );
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    const passwordFile = path.join(runtimeRoot, "postgres-password.tmp");
    await writeFile(passwordFile, decodeURIComponent(databaseUrl.password), { mode: 0o600 });
    try {
      await run(
        [
          path.join(postgresBin, "initdb"),
          "-D",
          databaseDir,
          "-U",
          "jobpilot",
          "--auth=scram-sha-256",
          `--pwfile=${passwordFile}`,
          "--encoding=UTF8",
          "--locale=C",
        ],
        { quiet: true },
      );
    } finally {
      await unlink(passwordFile);
    }
    await writeFile(
      path.join(databaseDir, "postgresql.auto.conf"),
      `listen_addresses = '127.0.0.1'\nport = ${databaseUrl.port}\nunix_socket_directories = '${socketDir.replaceAll("'", "''")}'\n`,
      { mode: 0o600 },
    );
  }
  const status = Bun.spawn([path.join(postgresBin, "pg_ctl"), "-D", databaseDir, "status"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await status.exited) !== 0)
    await run(
      [
        path.join(postgresBin, "pg_ctl"),
        "-D",
        databaseDir,
        "-l",
        path.join(runtimeRoot, "postgres.log"),
        "-w",
        "start",
      ],
      { quiet: true },
    );
  const pgEnv = { PGPASSWORD: decodeURIComponent(databaseUrl.password) };
  const psql = [
    path.join(postgresBin, "psql"),
    "-h",
    "127.0.0.1",
    "-p",
    databaseUrl.port,
    "-U",
    "jobpilot",
    "-d",
    "postgres",
    "-Atc",
  ];
  const found = await run(
    [...psql, "SELECT 1 FROM pg_database WHERE datname='jobpilot_personal'"],
    { env: pgEnv, quiet: true },
  );
  if (!found.trim())
    await run([...psql, "CREATE DATABASE jobpilot_personal"], { env: pgEnv, quiet: true });
}

export async function setup(): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  if (!existsSync(path.join(postgresBin, "initdb"))) {
    const brew = Bun.which("brew");
    if (!brew)
      throw new Error("Install PostgreSQL 17 and set JOBPILOT_POSTGRES_BIN to its bin directory");
    await run([brew, "install", "postgresql@17"], { env: { HOMEBREW_NO_AUTO_UPDATE: "1" } });
  }
  if (!existsSync(dotnet)) {
    const installer = path.join(runtimeRoot, "tools/dotnet-install.sh");
    await mkdir(path.dirname(installer), { recursive: true, mode: 0o700 });
    await run(["curl", "-fsSL", "https://dot.net/v1/dotnet-install.sh", "-o", installer]);
    await run([
      "bash",
      installer,
      "--channel",
      "10.0",
      "--quality",
      "GA",
      "--install-dir",
      path.dirname(dotnet),
      "--no-path",
    ]);
  }
  let config: RuntimeConfig;
  if (existsSync(path.join(runtimeRoot, "runtime.json"))) {
    config = await readConfig();
  } else {
    const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const port = Number(process.env.JOBPILOT_POSTGRES_PORT ?? 5433);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid JOBPILOT_POSTGRES_PORT");
    const source = path.join(repository, "resume");
    const sourceDocuments = existsSync(source)
      ? await Array.fromAsync(
          new Bun.Glob("*_Resume_MBB_Master.docx").scan({ cwd: source, absolute: true }),
        )
      : [];
    config = {
      apiEnv: {
        NODE_ENV: "development",
        HOST: "127.0.0.1",
        PORT: "4101",
        PERSONAL_MODE: "true",
        JOBPILOT_PERSONAL_ROOT: runtimeRoot,
        STORAGE_ROOT: path.join(runtimeRoot, "storage"),
        DATABASE_URL: `postgresql://jobpilot:${secret()}@127.0.0.1:${port}/jobpilot_personal`,
        JWT_SECRET: secret(),
        SECRET_MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          "base64",
        ),
        CORS_ORIGINS: "http://localhost:4100",
        APP_URL: "http://localhost:4100",
      },
      sourceJsonPath: path.join(source, "mbb/master.json"),
      sourceDocxPath: process.env.JOBPILOT_RESUME_DOCX ?? sourceDocuments[0] ?? "",
      comparisonPaths: [path.join(source, "master.json")],
      candidate: {},
      boardToken: "anthropic",
      account: { email: "personal@localhost.invalid", password: secret() },
    };
    if (!existsSync(config.sourceJsonPath) || !existsSync(config.sourceDocxPath)) {
      const fallback = await syntheticSources();
      config.sourceJsonPath = fallback.json;
      config.sourceDocxPath = fallback.docx;
      config.comparisonPaths = [];
      config.syntheticApplicant = true;
      console.log(
        "Resume sources unavailable; using a clearly synthetic applicant for the offline slice.",
      );
    }
    await privateWrite(path.join(runtimeRoot, "runtime.json"), config);
  }
  await ensureDatabase(config);
  await privateWrite(path.join(runtimeRoot, "broker-template.json"), {
    mcpServers: {
      jobpilot: {
        command: process.execPath,
        args: [path.join(repository, "plugin/scripts/personal-browser.ts")],
      },
    },
  });
  const apiDirectory = path.join(repository, "apps/api");
  await run([process.execPath, "run", "db:generate"], { cwd: apiDirectory, env: config.apiEnv });
  await run([process.execPath, "run", "db:migrate:apply"], {
    cwd: apiDirectory,
    env: config.apiEnv,
  });
  await run([process.execPath, "run", "db:seed", "--only", "job-boards"], {
    cwd: apiDirectory,
    env: config.apiEnv,
    quiet: true,
  });
  await run([process.execPath, path.join(repository, "scripts/personal/account.ts")], {
    cwd: apiDirectory,
    env: config.apiEnv,
    quiet: true,
  });
  if (!existsSync(chromium.executablePath()))
    console.log(
      "Browser setup missing: bunx playwright install chromium (offline preview remains available).",
    );
  console.log(
    "Private database and account configured. Credentials remain in runtime.json. Run bun run personal:dev.",
  );
}
