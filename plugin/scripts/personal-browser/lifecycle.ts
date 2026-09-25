import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const events = [
  "started",
  "tool_started",
  "tool_finished",
  "stdin_end",
  "sigint",
  "sigterm",
  "transport_closed",
  "transport_error",
  "uncaught",
  "rejection",
  "shutdown_deadline",
  "exit",
] as const;
const operations = [
  "inspect_form",
  "fill_field",
  "upload_resume",
  "upload_attachment",
  "submit_application",
  "reconcile",
] as const;
interface Lifecycle {
  record(
    event: (typeof events)[number],
    operation?: (typeof operations)[number],
    code?: number,
  ): void;
  close(): void;
}
const silent: Lifecycle = { record() {}, close() {} };
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** Fixed metadata only. Returned methods are synchronous, including during process exit. */
export async function createBrokerLifecycle(config: {
  root: string;
  attemptId: string;
}): Promise<Lifecycle> {
  let descriptor: number | undefined;
  const close = () => {
    if (descriptor === undefined) return;
    const current = descriptor;
    descriptor = undefined;
    try {
      fsyncSync(current);
    } catch {
      // Diagnostics must never change broker control flow.
    }
    try {
      closeSync(current);
    } catch {
      // Repeated or failed shutdown remains safe.
    }
  };
  try {
    const { root: configuredRoot, attemptId } = config;
    if (
      typeof configuredRoot !== "string" ||
      !isAbsolute(configuredRoot) ||
      typeof attemptId !== "string" ||
      !uuid.test(attemptId)
    )
      return silent;
    const normalizedRoot = resolve(configuredRoot);
    const initialRoot = lstatSync(normalizedRoot);
    if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink()) return silent;
    const root = await realpath(normalizedRoot);
    const currentRoot = lstatSync(normalizedRoot);
    if (
      !currentRoot.isDirectory() ||
      currentRoot.isSymbolicLink() ||
      currentRoot.dev !== initialRoot.dev ||
      currentRoot.ino !== initialRoot.ino
    )
      return silent;
    const directory = join(root, "diagnostics");
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return silent;
    }
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory)
      return silent;
    chmodSync(directory, 0o700);
    const path = join(directory, `${attemptId}-${randomUUID()}.lifecycle.jsonl`);
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const file = fstatSync(descriptor);
    const unchanged = () => {
      const currentParent = lstatSync(directory);
      const currentFile = lstatSync(path);
      return (
        currentParent.isDirectory() &&
        !currentParent.isSymbolicLink() &&
        currentParent.dev === parent.dev &&
        currentParent.ino === parent.ino &&
        realpathSync(directory) === directory &&
        currentFile.isFile() &&
        !currentFile.isSymbolicLink() &&
        currentFile.dev === file.dev &&
        currentFile.ino === file.ino
      );
    };
    if (!file.isFile() || !unchanged()) {
      close();
      return silent;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    let count = 0;
    return {
      record(event, operation, code) {
        if (descriptor === undefined || count >= 128) return;
        if (
          !events.includes(event) ||
          (operation !== undefined && !operations.includes(operation)) ||
          (code !== undefined && (typeof code !== "number" || !Number.isFinite(code)))
        )
          return;
        try {
          if (!unchanged()) {
            close();
            return;
          }
          const bytes = Buffer.from(
            `${JSON.stringify({
              capturedAt: new Date().toISOString(),
              pid: process.pid,
              attemptId,
              event,
              ...(operation === undefined ? {} : { operation }),
              ...(code === undefined ? {} : { code }),
            })}\n`,
          );
          let offset = 0;
          while (offset < bytes.length) {
            const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
            if (written <= 0) throw new Error();
            offset += written;
          }
          fsyncSync(descriptor);
          count++;
        } catch {
          close();
        }
      },
      close,
    };
  } catch {
    close();
    return silent;
  }
}
