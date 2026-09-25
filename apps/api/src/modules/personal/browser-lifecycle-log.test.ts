import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBrokerLifecycle } from "../../../../../plugin/scripts/personal-browser/lifecycle";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-lifecycle-synthetic-"));
  return {
    root,
    config: { root, attemptId },
    directory: join(root, "diagnostics"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
async function records(directory: string) {
  const files = await readdir(directory);
  const raw = await readFile(join(directory, files[0]!), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Private broker lifecycle metadata", () => {
  test("creates exclusive private logs and synchronously persists only fixed metadata", async () => {
    const f = await fixture();
    try {
      await mkdir(f.directory, { mode: 0o755 });
      const logger = await createBrokerLifecycle(f.config);
      expect(logger.record("started")).toBeUndefined();
      logger.record("tool_started", "inspect_form");
      logger.record("tool_finished", "inspect_form");
      logger.record("exit", undefined, 0);
      const saved = await records(f.directory);
      expect(saved.map((row) => row.event)).toEqual([
        "started",
        "tool_started",
        "tool_finished",
        "exit",
      ]);
      for (const row of saved) {
        expect(
          Object.keys(row).every((key) =>
            ["capturedAt", "pid", "attemptId", "event", "operation", "code"].includes(key),
          ),
        ).toBe(true);
        expect(row.attemptId).toBe(attemptId);
        expect(row.pid).toBe(process.pid);
        expect(Number.isFinite(Date.parse(row.capturedAt))).toBe(true);
      }
      const second = await createBrokerLifecycle(f.config);
      second.record("started");
      second.close();
      logger.close();
      const files = await readdir(f.directory);
      expect(files.length).toBe(2);
      for (const file of files) {
        expect(file).toMatch(new RegExp(`^${attemptId}-[a-f0-9-]{36}\\.lifecycle\\.jsonl$`));
        expect((await stat(join(f.directory, file))).mode & 0o777).toBe(0o600);
      }
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    } finally {
      await f.cleanup();
    }
  });

  test("rejects arbitrary metadata without coercing private values", async () => {
    const f = await fixture();
    try {
      const logger = await createBrokerLifecycle(f.config);
      const record = logger.record as (event: unknown, operation?: unknown, code?: unknown) => void;
      const hostile = {
        toJSON() {
          throw new Error("PRIVATE_CANARY");
        },
      };
      for (const event of ["PRIVATE_CANARY", "", hostile, null]) record(event);
      for (const operation of ["PRIVATE_CANARY", hostile, null, "fill_field PRIVATE_CANARY"])
        record("tool_started", operation);
      for (const code of ["PRIVATE_CANARY", hostile, null, Infinity, -Infinity, NaN])
        record("exit", undefined, code);
      record("started");
      logger.close();
      expect((await records(f.directory)).map((row) => row.event)).toEqual(["started"]);
      const raw = await readFile(join(f.directory, (await readdir(f.directory))[0]!), "utf8");
      expect(raw).not.toContain("PRIVATE_CANARY");
    } finally {
      await f.cleanup();
    }
  });

  test("bounds each log at 128 records and makes close idempotent", async () => {
    const f = await fixture();
    try {
      const logger = await createBrokerLifecycle(f.config);
      for (let i = 0; i < 200; i++) logger.record("tool_finished", "fill_field");
      expect((await records(f.directory)).length).toBe(128);
      expect(logger.close()).toBeUndefined();
      expect(logger.close()).toBeUndefined();
      logger.record("exit", undefined, 1);
      expect((await records(f.directory)).length).toBe(128);
    } finally {
      await f.cleanup();
    }
  });

  test("refuses invalid roots and IDs, missing directories and non-directory roots", async () => {
    const f = await fixture();
    try {
      const file = join(f.root, "file");
      await writeFile(file, "unchanged");
      for (const config of [
        { root: "relative", attemptId },
        { root: join(f.root, "missing"), attemptId },
        { root: file, attemptId },
        ...["../escape", `${attemptId}/other`, "invalid"].map((id) => ({
          root: f.root,
          attemptId: id,
        })),
      ]) {
        const logger = await createBrokerLifecycle(config);
        expect(() => {
          logger.record("started");
          logger.close();
          logger.close();
        }).not.toThrow();
      }
      expect(await readdir(f.root)).toEqual(["file"]);
    } finally {
      await f.cleanup();
    }
  });

  test("refuses symlink roots and diagnostics directories", async () => {
    const f = await fixture();
    const outside = await fixture();
    try {
      const linkedRoot = join(f.root, "linked-root");
      await symlink(outside.root, linkedRoot);
      const rootLogger = await createBrokerLifecycle({ root: linkedRoot, attemptId });
      rootLogger.record("started");
      rootLogger.close();
      const trailingSlashLogger = await createBrokerLifecycle({
        root: `${linkedRoot}/`,
        attemptId,
      });
      trailingSlashLogger.record("started");
      trailingSlashLogger.close();
      await symlink(outside.root, f.directory);
      const directoryLogger = await createBrokerLifecycle(f.config);
      directoryLogger.record("started");
      directoryLogger.close();
      expect(await readdir(outside.root)).toEqual([]);
    } finally {
      await f.cleanup();
      await outside.cleanup();
    }
  });

  test("swallows filesystem failures and refuses replaced parent or output paths", async () => {
    const f = await fixture();
    const outside = await fixture();
    try {
      const logger = await createBrokerLifecycle(f.config);
      logger.record("started");
      const file = (await readdir(f.directory))[0]!;
      const sentinel = join(outside.root, "sentinel");
      await writeFile(sentinel, "unchanged");
      await rm(join(f.directory, file));
      await symlink(sentinel, join(f.directory, file));
      expect(() => {
        logger.record("exit");
        logger.close();
      }).not.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      const second = await createBrokerLifecycle(f.config);
      second.record("started");
      const moved = join(f.root, "moved");
      await rename(f.directory, moved);
      await symlink(outside.root, f.directory);
      expect(() => {
        second.record("exit");
        second.close();
      }).not.toThrow();
      expect(await readdir(outside.root)).toEqual(["sentinel"]);
      await rm(f.directory);
      await mkdir(f.directory);
      const third = await createBrokerLifecycle(f.config);
      await rm(f.directory, { recursive: true });
      expect(() => {
        third.record("exit");
        third.close();
      }).not.toThrow();
    } finally {
      await f.cleanup();
      await outside.cleanup();
    }
  });

  test("flushes exit metadata synchronously from an actual process exit callback", async () => {
    const f = await fixture();
    try {
      const modulePath = resolve(
        import.meta.dir,
        "../../../../../plugin/scripts/personal-browser/lifecycle.ts",
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { createBrokerLifecycle } from ${JSON.stringify(modulePath)};
        const logger = await createBrokerLifecycle(${JSON.stringify(f.config)});
        logger.record('started');
        process.on('exit', code => { logger.record('exit', undefined, code); logger.close(); });
        process.exit(7);
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(7);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
      const saved = await records(f.directory);
      expect(saved.map((row) => row.event)).toEqual(["started", "exit"]);
      expect(saved[1].code).toBe(7);
      expect(saved[1].pid).toBe(child.pid);
    } finally {
      await f.cleanup();
    }
  });
});
