import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type PersonalRecruitingSnapshot,
  personalRecruitingManifestSchema,
  personalRecruitingSnapshotSchema,
} from "../../packages/contracts/src/personal-recruiting";
import { renderRecruitingHtml } from "./recruiting-html";

const relativeSource = "data/mbb/recruiting-operations.json";
const maximumBytes = 2 * 1024 * 1024;
const defaultJobpilotRoot = path.resolve(import.meta.dir, "../..");

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function resolveProspectiveRoot(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await resolveProspectiveRoot(parent), path.basename(target));
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "protocol.allow=never",
      "-C",
      root,
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...environment,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error("Unable to inspect the source Git repository");
  return stdout.trim();
}

async function regularFile(file: string, privateMode: boolean): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximumBytes ||
      (privateMode && (info.mode & 0o077 || info.nlink !== 1))
    ) {
      throw new Error("Recruiting file must be a bounded regular file with private permissions");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) throw new Error("Recruiting file exceeds the size limit");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Recruiting output directory cannot be a symlink");
  await chmod(directory, 0o700);
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeImmutable(file: string, bytes: string): Promise<void> {
  try {
    if ((await regularFile(file, true)).toString("utf8") !== bytes)
      throw new Error("Immutable recruiting artifact mismatch");
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The import lock excludes other writers; readers see only complete immutable files.
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function withImportLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(directory, ".import.lock");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "Recruiting import is locked; if an earlier process was interrupted, inspect recruiting/.import.lock before retrying",
      );
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}

async function writeLatest(file: string, bytes: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Unsafe recruiting latest artifact");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeImmutable(temporary, bytes);
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export async function loadRecruitingSnapshot(
  runtimeRoot: string,
): Promise<PersonalRecruitingSnapshot | null> {
  const root = path.resolve(runtimeRoot);
  const directory = path.join(root, "recruiting");
  try {
    for (const folder of [root, directory]) {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
        throw new Error("Recruiting runtime must use private directories without symlinks");
    }
    return personalRecruitingSnapshotSchema.parse(
      JSON.parse((await regularFile(path.join(directory, "latest.json"), true)).toString("utf8")),
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function importRecruitingManifest(options: {
  sourceRoot: string;
  runtimeRoot: string;
  jobpilotRoot?: string;
  capturedAt?: string;
}): Promise<{
  snapshot: PersonalRecruitingSnapshot;
  snapshotPath: string;
  receiptPath: string;
  htmlPath: string;
  reused: boolean;
}> {
  const sourceRoot = await realpath(path.resolve(options.sourceRoot));
  const jobpilotRoot = await realpath(
    await git(options.jobpilotRoot ?? defaultJobpilotRoot, "rev-parse", "--show-toplevel"),
  );
  if (within(sourceRoot, jobpilotRoot) || within(jobpilotRoot, sourceRoot))
    throw new Error("Source must be a separate repository outside JobPilot");
  if ((await realpath(await git(sourceRoot, "rev-parse", "--show-toplevel"))) !== sourceRoot)
    throw new Error("Source root must be the repository root");
  const requestedRuntimeRoot = path.resolve(options.runtimeRoot);
  try {
    if ((await lstat(requestedRuntimeRoot)).isSymbolicLink())
      throw new Error("Private runtime root cannot be a symlink");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const runtimeRoot = await resolveProspectiveRoot(requestedRuntimeRoot);
  for (const root of [sourceRoot, jobpilotRoot]) {
    if (within(runtimeRoot, root) || within(root, runtimeRoot))
      throw new Error("Private runtime must be outside and separate from both repositories");
  }
  const sourcePath = path.join(sourceRoot, relativeSource);
  if ((await realpath(sourcePath)) !== sourcePath)
    throw new Error("Source manifest path cannot contain symlinks");
  const sourceBytes = await regularFile(sourcePath, false);
  const manifest = personalRecruitingManifestSchema.parse(JSON.parse(sourceBytes.toString("utf8")));
  const [gitHead, gitStatus] = await Promise.all([
    git(sourceRoot, "rev-parse", "HEAD"),
    git(sourceRoot, "status", "--porcelain", "--untracked-files=normal"),
  ]);
  const source = {
    root: sourceRoot,
    relativePath: relativeSource,
    sha256: sha256(sourceBytes),
    gitHead,
    gitDirty: gitStatus.length > 0,
  };
  const candidate = personalRecruitingSnapshotSchema.parse({
    schemaVersion: 1,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    source,
    manifest,
  });
  const snapshotId = sha256(JSON.stringify(source));
  const directory = path.join(runtimeRoot, "recruiting");
  const snapshots = path.join(directory, "snapshots");
  await privateDirectory(runtimeRoot);
  await privateDirectory(directory);
  await privateDirectory(snapshots);
  return withImportLock(directory, async () => {
    const snapshotPath = path.join(snapshots, `${snapshotId}.json`);
    const receiptPath = path.join(snapshots, `${snapshotId}.receipt.json`);
    let snapshot = candidate;
    let reused = false;
    try {
      snapshot = personalRecruitingSnapshotSchema.parse(
        JSON.parse((await regularFile(snapshotPath, true)).toString("utf8")),
      );
      if (
        JSON.stringify(snapshot.source) !== JSON.stringify(source) ||
        JSON.stringify(snapshot.manifest) !== JSON.stringify(manifest)
      )
        throw new Error("Immutable recruiting snapshot mismatch");
      reused = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const json = `${JSON.stringify(snapshot, null, 2)}\n`;
    const html = renderRecruitingHtml(snapshot);
    if ([json, html].some((bytes) => Buffer.byteLength(bytes) > maximumBytes))
      throw new Error("Rendered recruiting artifact exceeds the size limit");
    await writeImmutable(snapshotPath, json);
    await writeImmutable(path.join(snapshots, `${snapshotId}.html`), html);
    await writeImmutable(
      receiptPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          snapshotId,
          capturedAt: snapshot.capturedAt,
          source,
          snapshotSha256: sha256(json),
          htmlSha256: sha256(html),
          delivery: "local_only",
          sourceModified: false,
        },
        null,
        2,
      )}\n`,
    );
    await writeLatest(path.join(directory, "latest.json"), json);
    const htmlPath = path.join(directory, "latest.html");
    await writeLatest(htmlPath, html);
    return { snapshot, snapshotPath, receiptPath, htmlPath, reused };
  });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let sourceRoot: string | undefined;
    let runtimeRoot =
      process.env.JOBPILOT_PERSONAL_ROOT ??
      path.join(os.homedir(), "Library/Application Support/JobPilotPersonal");
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("Expected --source-root <repository> [--runtime-root <private directory>]");
      if (flag === "--source-root") sourceRoot = value;
      else if (flag === "--runtime-root") runtimeRoot = value;
      else throw new Error("Unknown recruiting option");
    }
    if (!sourceRoot) throw new Error("Required: --source-root <repository>");
    const result = await importRecruitingManifest({ sourceRoot, runtimeRoot });
    console.log(
      JSON.stringify(
        {
          status: result.reused ? "unchanged" : "created",
          snapshotPath: result.snapshotPath,
          receiptPath: result.receiptPath,
          htmlPath: result.htmlPath,
          sourceSha256: result.snapshot.source.sha256,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Recruiting import failed");
    process.exitCode = 1;
  }
}
