import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const testFile = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const excluded = new Set(["node_modules", "dist", "coverage", ".git", "generated"]);
// Broker defaults can launch Chromium even when a test never imports Playwright directly.
const browserTest =
  /@playwright\/|\b(?:chromium|firefox|webkit|PlaywrightDriver|GreenhouseDriver|LeverDriver|HandoffBrowser|PersonalBrowserBroker)\b|personal-browser\.ts/;
const valueFlags = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "-t",
  "--test-name-pattern",
  "--max-concurrency",
  "--path-ignore-patterns",
]);
const aggregateFlags = new Set([
  "--coverage",
  "--coverage-reporter",
  "--coverage-dir",
  "--reporter",
  "--reporter-outfile",
  "--shard",
  "--changed",
  "--parallel",
  "--parallel-delay",
  "--watch",
  "--test-worker",
]);

async function inventory(directory = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !excluded.has(entry.name) && !entry.name.startsWith("."))
      files.push(...(await inventory(path)));
    else if (entry.isFile() && testFile.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function main() {
  const filters: string[] = [];
  const flags: string[] = [];
  let list = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const flag = arg.split("=", 1)[0]!;
    if (arg === "--") continue;
    if (arg === "--list") {
      list = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run test [path filters] [Bun test flags] [--list]\n" +
          "Runs shared tests together and browser tests in fresh sequential Bun processes.\n" +
          "--list prints the exact partition without running tests.\n" +
          "Use bun test directly for coverage, reporters, shards, changed files, or watch mode.",
      );
      return 0;
    } else if (aggregateFlags.has(flag)) {
      throw new Error(`${flag} requires a single Bun invocation; use bun test directly.`);
    } else if (arg.startsWith("-")) {
      flags.push(arg);
      if (valueFlags.has(flag) && !arg.includes("=")) {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
        flags.push(value);
      }
    } else filters.push(arg.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  const all = await inventory();
  const selected = all.filter(
    (file) => filters.length === 0 || filters.some((filter) => file.includes(filter)),
  );
  if (selected.length === 0) throw new Error("No API test files matched the requested paths.");
  const shared: string[] = [];
  const isolated: string[] = [];
  for (const file of selected) {
    const source = await readFile(join(root, file), "utf8");
    (browserTest.test(source) ? isolated : shared).push(file);
  }
  const groups = [...(shared.length ? [shared] : []), ...isolated.map((file) => [file])];
  const flattened = groups.flat();
  if (
    flattened.length !== selected.length ||
    new Set(flattened).size !== selected.length ||
    selected.some((file) => !flattened.includes(file))
  )
    throw new Error("API test partition does not cover every selected file exactly once.");
  if (list) {
    console.log(JSON.stringify({ discovered: all.length, selected: selected.length, groups }));
    return 0;
  }
  console.log(
    `API tests: ${selected.length}/${all.length} files; ${shared.length} shared, ${isolated.length} isolated.`,
  );
  let failed = 0;
  for (const [index, files] of groups.entries()) {
    console.log(`API test process ${index + 1}/${groups.length}: ${files.join(", ")}`);
    try {
      // Fresh processes avoid accumulated Bun/Playwright stdio state; failures are never retried.
      const child = Bun.spawn(
        [process.execPath, "test", ...flags, ...files.map((file) => `./${file}`)],
        { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      );
      if ((await child.exited) !== 0) failed++;
    } catch {
      console.error(`API test process ${index + 1} could not start.`);
      failed++;
    }
  }
  console.log(`API test processes: ${groups.length - failed} passed, ${failed} failed.`);
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "API test runner failed.");
  process.exitCode = 1;
}
