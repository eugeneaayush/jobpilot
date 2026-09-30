import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth";
import { HttpError } from "@/common/errors";
import { env } from "@/env";
import { personalApprovalGuard } from "./approval.guard";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const owner = { id: crypto.randomUUID(), email: "synthetic@example.test", role: "USER" };
const original = {
  PERSONAL_MODE: env.PERSONAL_MODE,
  JOBPILOT_PERSONAL_ROOT: env.JOBPILOT_PERSONAL_ROOT,
  CORS_ORIGINS: env.CORS_ORIGINS,
};
let directory: string;
let token: string;
const app = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.message };
    }
  })
  .use(personalApprovalGuard)
  .get("/review", ({ user }) => ({ id: user.id }));
const request = (headers: Record<string, string>) =>
  app.handle(new Request("http://localhost/review", { headers }));

describe("dashboard application approval guard", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "jobpilot-approval-guard-"));
    env.PERSONAL_MODE = true;
    env.JOBPILOT_PERSONAL_ROOT = directory;
    env.CORS_ORIGINS = "http://localhost:4100";
    await writeFile(
      join(directory, "runtime.json"),
      JSON.stringify({ account: { userId: owner.id } }),
    );
    token = await signAccessToken(owner);
  });
  afterAll(async () => {
    Object.assign(env, original);
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("accepts only the configured owner's valid dashboard cookie", async () => {
    expect(
      (await request({ origin: "http://localhost:4100", cookie: `accessToken=${token}` })).status,
    ).toBe(200);
    const other = await signAccessToken({ ...owner, id: crypto.randomUUID() });
    expect(
      (await request({ origin: "http://localhost:4100", cookie: `accessToken=${other}` })).status,
    ).toBe(403);
  });
  it("rejects PAT cookies, bearer JWTs, and bearer headers accompanying valid cookies", async () => {
    const variations: Record<string, string>[] = [
      { cookie: "accessToken=synthetic-pat" },
      { authorization: `Bearer ${token}` },
      { authorization: "Bearer synthetic-pat", cookie: `accessToken=${token}` },
    ];
    for (const headers of variations)
      expect(
        (await request({ origin: "http://localhost:4100", ...headers })).status,
      ).toBeGreaterThanOrEqual(401);
  });
  it("accepts a same-origin GET referer without relaxing mutation origin checks", async () => {
    expect(
      (await request({ cookie: `accessToken=${token}`, referer: "http://localhost:4100/personal" }))
        .status,
    ).toBe(200);
  });
  it("rejects absent and foreign origins even with a valid session", async () => {
    expect((await request({ cookie: `accessToken=${token}` })).status).toBe(403);
    expect(
      (await request({ cookie: `accessToken=${token}`, origin: "https://attacker.test" })).status,
    ).toBe(403);
  });
});
