import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { saveBrokerDiagnostic } from "../../../../../plugin/scripts/personal-browser/diagnostics";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jobpilot-diagnostic-synthetic-"));
  return {
    root,
    config: { root, attemptId, token: "SYNTHETIC_PRIVATE_TOKEN" },
    path: join(root, "diagnostics", `${attemptId}.json`),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("Private broker diagnostics", () => {
  test("redacts secrets, overlapping values, encoded values, paths, queries, emails and phones", async () => {
    const f = await fixture();
    try {
      const privateValue = "PRIVATE_PERSON_LONG";
      const encoded = "PRIVATE ANSWER/with space";
      const error = new Error(
        [
          `failed ${f.config.token} ${privateValue} PRIVATE_PERSON`,
          `${encoded} ${encodeURIComponent(encoded)}`,
          `${f.root}/document.pdf ${await realpath(f.root)}/receipt.json ${homedir()}/source.json`,
          "https://synthetic.example.test/form?secret=QUERY_CANARY#FRAGMENT_CANARY",
          "/relative?token=RELATIVE_CANARY synthetic.person@example.test +1 (202) 555-0123",
          "/Users/synthetic-person/private.json",
          "C:\\Users\\synthetic-person\\private.json",
        ].join("\n"),
      );
      error.name = "PRIVATE_ERROR_NAME";
      error.stack = "PRIVATE_STACK_CANARY";
      await saveBrokerDiagnostic(f.config, "fill_field", error, [
        "PRIVATE_PERSON",
        privateValue,
        encoded,
      ]);
      const raw = await readFile(f.path, "utf8");
      for (const secret of [
        f.config.token,
        privateValue,
        "PRIVATE_PERSON",
        "_LONG",
        encoded,
        encodeURIComponent(encoded),
        f.root,
        await realpath(f.root),
        homedir(),
        "QUERY_CANARY",
        "FRAGMENT_CANARY",
        "RELATIVE_CANARY",
        "synthetic.person@example.test",
        "synthetic-person",
        "PRIVATE_ERROR_NAME",
        "PRIVATE_STACK_CANARY",
      ])
        expect(raw).not.toContain(secret);
      const saved = JSON.parse(raw);
      expect(saved.error.message).not.toContain("202");
      expect(saved.operation).toBe("fill_field");
      expect(saved.attemptId).toBe(attemptId);
      expect(saved.error.name).toBe("Error");
      expect(saved.error.message).toContain("https://synthetic.example.test/form?[redacted]");
      expect(Number.isFinite(Date.parse(saved.capturedAt))).toBe(true);
      expect(saved.error).not.toHaveProperty("stack");
    } finally {
      await f.cleanup();
    }
  });

  test("keeps only the latest bounded complete JSON with private permissions", async () => {
    const f = await fixture();
    try {
      await saveBrokerDiagnostic(f.config, "inspect_form", new Error("old"));
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          saveBrokerDiagnostic(
            f.config,
            "inspect_form",
            new TypeError(`failure ${i} ${"x".repeat(3000)}`),
          ),
        ),
      );
      const saved = JSON.parse(await readFile(f.path, "utf8"));
      expect(saved.error.message.length).toBe(2000);
      expect(saved.error.message).not.toContain("old");
      expect(saved.error.name).toBe("TypeError");
      expect(await readdir(join(f.root, "diagnostics"))).toEqual([`${attemptId}.json`]);
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(f.root, "diagnostics"))).mode & 0o777).toBe(0o700);
      await saveBrokerDiagnostic(f.config, "inspect_form", "x".repeat(100001));
      expect(JSON.parse(await readFile(f.path, "utf8")).error.message).toBe(
        "Diagnostic message exceeded the size limit",
      );
    } finally {
      await f.cleanup();
    }
  });

  test("rejects traversal, unbounded operation names and nonabsolute roots without throwing", async () => {
    const f = await fixture();
    try {
      for (const id of ["../escape", `${attemptId}/other`, "invalid"])
        await saveBrokerDiagnostic({ ...f.config, attemptId: id }, "inspect_form", "failure");
      for (const operation of ["../escape", "private email@example.test", "a".repeat(65), ""])
        await saveBrokerDiagnostic(f.config, operation, "failure");
      await saveBrokerDiagnostic({ ...f.config, root: "relative" }, "inspect_form", "failure");
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("refuses a symlink diagnostics directory and never follows an existing output symlink", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "jobpilot-diagnostic-outside-synthetic-"));
    try {
      const sentinel = join(outside, "sentinel.json");
      await writeFile(sentinel, "unchanged");
      const directory = join(f.root, "diagnostics");
      await symlink(outside, directory);
      await saveBrokerDiagnostic(f.config, "inspect_form", "failure");
      expect(await readdir(outside)).toEqual(["sentinel.json"]);
      await rm(directory);
      await mkdir(directory);
      await symlink(sentinel, f.path);
      await saveBrokerDiagnostic(f.config, "inspect_form", "replacement");
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      expect((await lstat(f.path)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(f.path, "utf8")).error.message).toBe("replacement");
    } finally {
      await f.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("logging failures never mask the original error and temporary files are cleaned", async () => {
    const f = await fixture();
    try {
      await mkdir(f.path, { recursive: true });
      const original = new Error("ORIGINAL_FAILURE");
      const caught = await (async () => {
        try {
          throw original;
        } catch (error) {
          await saveBrokerDiagnostic(f.config, "submit_application", error);
          return error;
        }
      })();
      expect(caught).toBe(original);
      expect(await readdir(join(f.root, "diagnostics"))).toEqual([`${attemptId}.json`]);
      await saveBrokerDiagnostic(
        { ...f.config, root: join(f.root, "missing") },
        "inspect_form",
        original,
      );
      const hostile = new Error("failure");
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("getter");
        },
      });
      await saveBrokerDiagnostic(f.config, "inspect_form", hostile);
    } finally {
      await f.cleanup();
    }
  });
});
