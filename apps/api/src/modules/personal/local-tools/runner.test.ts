import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeLocalTool } from "./runner";
import { afterEach, expect, test } from "bun:test";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(body: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jobpilot-tools-test-"));
  directories.push(directory);
  const executable = path.join(directory, "python");
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { directory, executable };
}

const request = {
  protocolVersion: 1 as const,
  requestId: "test",
  operation: "capabilities" as const,
  payload: {},
};
const good = `const q = JSON.parse(await new Response(Bun.stdin.stream()).text()); console.log(JSON.stringify({...q, payload:undefined,status:'ok',result:{operations:['capabilities'],components:{python:'fixture'},verifierVersion:'1'}}));`;

test("validates strict protocol and cleans the operation directory", async () => {
  const { directory, executable } = await fixture(good);
  const output = await executeLocalTool(request, { root: directory, executable });
  expect(output.result.components.python).toBe("fixture");
  expect(await readdir(directory)).toEqual(["python"]);
});

test("refuses mismatched identities, malformed and oversized responses", async () => {
  for (const body of [
    good.replace("...q,", "...q, requestId:'wrong',"),
    "console.log('not json')",
    "console.log('x'.repeat(2100000))",
  ]) {
    const { directory, executable } = await fixture(body);
    await expect(executeLocalTool(request, { root: directory, executable })).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["python"]);
  }
});

test("does not pass credentials or private runtime configuration to children", async () => {
  const { directory, executable } = await fixture(
    `if (process.env.JOBPILOT_API_TOKEN || process.env.DATABASE_URL || process.env.JOBPILOT_PERSONAL_ROOT) process.exit(9); ${good}`,
  );
  const previous = process.env.JOBPILOT_API_TOKEN;
  process.env.JOBPILOT_API_TOKEN = "synthetic-secret";
  try {
    expect(
      (await executeLocalTool(request, { root: directory, executable })).result.verifierVersion,
    ).toBe("1");
  } finally {
    if (previous === undefined) delete process.env.JOBPILOT_API_TOKEN;
    else process.env.JOBPILOT_API_TOKEN = previous;
  }
});

test("cancels bounded children and rejects unsafe input filenames", async () => {
  const { directory, executable } = await fixture("setInterval(()=>{}, 1000)");
  await expect(
    executeLocalTool(request, { root: directory, executable, timeoutMs: 30 }),
  ).rejects.toThrow();
  await expect(
    executeLocalTool(request, {
      root: directory,
      executable,
      inputFiles: { "../escape": new Uint8Array() },
    }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeLocalTool(request, { root: directory, executable, signal: controller.signal }),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual(["python"]);
});

test("refuses escaped, symlinked, or incorrectly hashed returned artifacts", async () => {
  const discoveryRequest = {
    ...request,
    operation: "discover_jobs" as const,
    payload: { board: "linkedin" as const, query: "synthetic", limit: 1 },
  };
  for (const variant of ["wrong_hash", "path_escape", "symlink"]) {
    const filename = variant === "path_escape" ? "../python" : "snapshot.json";
    const writer =
      variant === "symlink"
        ? "await import('node:fs/promises').then(fs=>fs.symlink('../python','snapshot.json'));"
        : "await Bun.write('snapshot.json','{}');";
    const { directory, executable } = await fixture(`
      const q = JSON.parse(await new Response(Bun.stdin.stream()).text());
      ${writer}
      console.log(JSON.stringify({protocolVersion:1,requestId:q.requestId,operation:q.operation,status:'ok',result:{
        board:'linkedin',status:'empty',leads:[],snapshotFilename:${JSON.stringify(filename)},
        responseSha256:'${"0".repeat(64)}',cooldownSeconds:null,diagnostics:[]
      }}));
    `);
    await expect(
      executeLocalTool(discoveryRequest, { root: directory, executable }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["python"]);
  }
});
