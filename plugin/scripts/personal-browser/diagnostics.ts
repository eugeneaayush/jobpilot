import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

interface DiagnosticConfig {
  root: string;
  attemptId: string;
  token: string;
}

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
]);

function redact(message: string, secrets: string[]) {
  if (message.length > 100_000) return "Diagnostic message exceeded the size limit";
  const values = new Set<string>();
  for (const value of secrets) {
    if (!value) continue;
    values.add(value);
    values.add(encodeURIComponent(value));
    values.add(JSON.stringify(value).slice(1, -1));
  }
  for (const value of [...values].sort((a, b) => b.length - a.length))
    message = message.split(value).join("[redacted]");
  message = message
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/\?[^\s<>"']+/g, "?[redacted]")
    .replace(/\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\r\n"'<>]+/gi, "[redacted-path]")
    .replace(/\/(?:Users|home)\/[^\s/"'<>]+(?:\/[^\r\n"'<>]*)?/g, "[redacted-path]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:\+?\d[\s().-]*){10,15}(?!\d)/g, "[redacted-phone]");
  return [...message]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join("")
    .slice(0, 2000);
}

/** Diagnostics are local evidence only; a logging failure must never replace the broker error. */
export async function saveBrokerDiagnostic(
  config: DiagnosticConfig,
  operation: string,
  error: unknown,
  privateValues: string[] = [],
): Promise<void> {
  let temporary: string | undefined;
  try {
    if (
      !isAbsolute(config.root) ||
      !uuid.test(config.attemptId) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(operation)
    )
      return;
    const root = await realpath(config.root);
    const directory = join(root, "diagnostics");
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
    }
    const directoryStat = await lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      return;
    await chmod(directory, 0o700);
    const name = error instanceof Error && errorNames.has(error.name) ? error.name : "Error";
    let rawMessage = "Unknown broker error";
    if (error instanceof Error) rawMessage = error.message;
    else if (typeof error === "string") rawMessage = error;
    const diagnostic = {
      schemaVersion: 1,
      attemptId: config.attemptId,
      operation,
      capturedAt: new Date().toISOString(),
      error: {
        name,
        message: redact(rawMessage, [config.token, config.root, root, homedir(), ...privateValues]),
      },
    };
    temporary = join(directory, `.${config.attemptId}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(diagnostic));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, `${config.attemptId}.json`));
    temporary = undefined;
  } catch {
    // Diagnostics are best effort and must not alter the caller's error handling.
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}
