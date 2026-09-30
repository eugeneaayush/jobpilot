import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeLocalTool,
  localToolsPython,
} from "../../apps/api/src/modules/personal/local-tools/runner";
import { repository, run } from "./common";

/** Installation is explicit setup work; API operations never install tools. */
export async function setupLocalTools() {
  const uv = Bun.which("uv");
  if (!uv)
    throw new Error(
      "Install uv and run bun run personal:tools:setup; see docs/integration/SETUP.md",
    );
  await run([uv, "sync", "--frozen", "--python", "3.12", "--no-dev"], {
    cwd: path.join(repository, "services/local-tools"),
  });
  return localToolsCapabilities();
}

export async function localToolsCapabilities() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobpilot-tools-doctor-"));
  try {
    return (
      await executeLocalTool(
        {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          operation: "capabilities",
          payload: {},
        },
        { root, executable: localToolsPython() },
      )
    ).result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
