import path from "node:path";
import type { PersonalDashboard, PersonalRecordDto } from "../../packages/contracts/src/personal";
import { apiRequest, dotnet, readConfig, repository, runtimeRoot } from "./common";
import { setupLocalTools } from "./local-tools";
import { operation } from "./operations";
import { doctor, ensureDatabase, setup } from "./setup";

async function dev(): Promise<void> {
  const config = await readConfig();
  await ensureDatabase(config);
  const env = {
    ...process.env,
    DOTNET_ROOT: path.dirname(dotnet),
    JOBPILOT_PERSONAL_ROOT: runtimeRoot,
    JOBPILOT_API: "http://localhost:4101",
    JOBPILOT_WEB: "http://localhost:4100",
    NEXT_PUBLIC_API_URL: "http://localhost:4101",
    NEXT_PUBLIC_TERMINAL_URL: "http://localhost:4102",
    JOBPILOT_WORKER_MCP_CONFIG: path.join(runtimeRoot, "broker-template.json"),
  };
  const children = [
    Bun.spawn([process.execPath, "run", "src/app.ts"], {
      cwd: path.join(repository, "apps/api"),
      env: { ...env, ...config.apiEnv },
      stdout: "inherit",
      stderr: "inherit",
    }),
    Bun.spawn([process.execPath, "run", "next", "dev", "-p", "4100", "-H", "127.0.0.1"], {
      cwd: path.join(repository, "apps/web"),
      env,
      stdout: "inherit",
      stderr: "inherit",
    }),
    Bun.spawn([dotnet, "run", "--project", path.join(repository, "apps/terminal")], {
      cwd: repository,
      env,
      stdout: "inherit",
      stderr: "inherit",
    }),
    Bun.spawn([process.execPath, path.join(repository, "scripts/personal/pilot.ts")], {
      cwd: repository,
      env,
      stdout: "inherit",
      stderr: "inherit",
    }),
  ];
  const stop = () => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Private dashboard: http://localhost:4100/personal");
  await Promise.race(children.map((child) => child.exited));
  stop();
  await Promise.all(children.map((child) => child.exited));
}

async function preview(): Promise<void> {
  const config = await readConfig();
  const intake = await apiRequest(config, "/personal/intake", {}, "POST");
  console.log("Résumé intake persisted.");
  const discovery = await apiRequest(config, "/personal/discover", {
    boardToken: config.boardToken,
  });
  console.log(JSON.stringify(discovery));
  const records: PersonalRecordDto[] = [];
  for (let page = 1; ; page++) {
    const dashboard = (await apiRequest(
      config,
      `/personal?page=${page}&limit=100`,
    )) as PersonalDashboard;
    records.push(...dashboard.records.items);
    if (page >= dashboard.records.pagination.totalPages) break;
  }
  const record = records
    .filter(
      (row) =>
        row.eligibility.decision !== "ineligible" &&
        ["graduate_recruiting", "experienced_professional"].includes(
          row.seniority?.classification ?? "unresolved",
        ) &&
        !["applying", "submitted", "submission_uncertain"].includes(row.state),
    )
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || a.title.localeCompare(b.title))[0];
  if (!record)
    throw new Error("Source returned no inspectable postings; see source-health dashboard");
  const outcome = (await apiRequest(config, `/personal/${record.id}/preview`, {}, "POST")) as {
    id: string;
    preview: { pdfHash: string; manifestHash: string; readiness: string; conflicts: string[] };
  };
  console.log(
    JSON.stringify(
      {
        recordId: outcome.id,
        pdfHash: outcome.preview.pdfHash,
        manifestHash: outcome.preview.manifestHash,
        readiness: outcome.preview.readiness,
        conflicts: outcome.preview.conflicts.length,
        intakeSaved: Boolean(intake),
        dashboard: "http://localhost:4100/personal",
        submitted: false,
      },
      null,
      2,
    ),
  );
}

try {
  const command = process.argv[2];
  if (command === "doctor") await doctor();
  else if (command === "tools-setup") console.log(JSON.stringify(await setupLocalTools(), null, 2));
  else if (command === "setup") await setup();
  else if (command === "dev") await dev();
  else if (command === "preview") await preview();
  else if (
    ["reassess", "discover", "search", "tailor", "tailor-review", "registry", "digest"].includes(
      command ?? "",
    )
  )
    await operation(command!, process.argv.slice(3));
  else
    throw new Error(
      "Expected doctor, setup, dev, preview, reassess, discover, search, tailor, tailor-review, registry or digest",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Personal command failed");
  process.exitCode = 1;
}
