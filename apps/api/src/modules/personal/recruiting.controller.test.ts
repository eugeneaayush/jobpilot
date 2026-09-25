import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { errorMiddleware } from "@/common/middleware/error.middleware";
import { env } from "@/env";
import { httpErrorResponses } from "@/types/response";
import { personalRecruitingController } from "./recruiting.controller";
import { recruitingSnapshotFixture } from "./recruiting-test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const app = new Elysia()
  .use(errorMiddleware)
  .guard({ as: "scoped", response: httpErrorResponses })
  .group("/api", (api) => api.use(personalRecruitingController));
const previous = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
};
let root: string;
let ownerToken: string;
let foreignToken: string;

function request(token?: string) {
  return new Request("http://localhost/api/personal/recruiting", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("private recruiting route", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "recruiting-route-"));
    const ownerId = crypto.randomUUID();
    await writeFile(
      path.join(root, "runtime.json"),
      JSON.stringify({ account: { userId: ownerId } }),
      { mode: 0o600 },
    );
    await mkdir(path.join(root, "recruiting"), { mode: 0o700 });
    await writeFile(
      path.join(root, "recruiting", "latest.json"),
      JSON.stringify(recruitingSnapshotFixture()),
      { mode: 0o600 },
    );
    env.PERSONAL_MODE = true;
    env.JOBPILOT_PERSONAL_ROOT = root;
    ownerToken = await signAccessToken({ id: ownerId, email: "owner@example.test", role: "USER" });
    foreignToken = await signAccessToken({
      id: crypto.randomUUID(),
      email: "foreign@example.test",
      role: "USER",
    });
  });

  afterAll(async () => {
    Object.assign(env, previous);
    await rm(root, { recursive: true, force: true });
  });

  it("requires authentication and the configured private owner", async () => {
    expect((await app.handle(request())).status).toBe(401);
    const foreignResponse = await app.handle(request(foreignToken));
    expect(foreignResponse.status).toBe(403);
    expect(await foreignResponse.text()).not.toContain("Synthetic");
    const response = await app.handle(request(ownerToken));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("available");
    expect(body.snapshot.manifest.firms).toHaveLength(3);
    expect(body.snapshot.manifest.firms[0].events[0].attendanceStatus).toBe("unknown");
    expect(JSON.stringify(body)).not.toContain("private-source");
    expect(JSON.stringify(body)).not.toContain("private-email-identifier");
  });

  it("fails closed when personal mode is disabled even for a valid owner token", async () => {
    env.PERSONAL_MODE = false;
    try {
      const response = await app.handle(request(ownerToken));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("Synthetic");
    } finally {
      env.PERSONAL_MODE = true;
    }
  });
});
