import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRecruitingSnapshot } from "../../../../../scripts/personal/recruiting";
import { personalRecruitingResponseSchema } from "./recruiting.schema";
import { readRecruitingDashboard } from "./recruiting-loader";
import { recruitingSnapshotFixture } from "./recruiting-test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let root: string;
let file: string;

async function expectLoaderStatus(
  directory: string,
  expected: "available" | "missing" | "invalid",
) {
  const [api, cli] = await Promise.all([
    readRecruitingDashboard(directory),
    loadRecruitingSnapshot(directory).then(
      (snapshot) => (snapshot ? "available" : "missing"),
      () => "invalid",
    ),
  ]);
  expect(api.status).toBe(expected);
  expect(cli).toBe(expected);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "recruiting-dashboard-"));
  await mkdir(path.join(root, "recruiting"), { mode: 0o700 });
  file = path.join(root, "recruiting", "latest.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read-only recruiting snapshot", () => {
  it("converts HTTP dates, keeps registration distinct, and excludes private source locators", async () => {
    const original = JSON.stringify(recruitingSnapshotFixture());
    await writeFile(file, original, { mode: 0o600 });
    const result = await readRecruitingDashboard(root);
    expect(personalRecruitingResponseSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("available");
    expect(result.snapshot?.manifest.officePreferences).toEqual(["New York", "Miami", "Houston"]);
    expect(result.snapshot?.manifest.firms.map((firm) => firm.id)).toEqual([
      "mckinsey",
      "bain",
      "bcg",
    ]);
    expect(result.snapshot?.capturedAt).toBeInstanceOf(Date);
    expect(result.snapshot?.manifest.firms[0]?.deadline.date?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(result.snapshot?.manifest.firms[0]?.events[0]).toMatchObject({
      registrationStatus: "registered",
      attendanceStatus: "unknown",
      startAt: new Date("2026-10-01T14:00:00Z"),
    });
    expect(result.snapshot?.manifest.evidence[0]?.url).toBeNull();
    expect(result.snapshot?.manifest.evidence[1]?.url).toBe("https://example.test/recruiting");
    expect(JSON.stringify(result)).not.toContain("private-email-identifier");
    expect(JSON.stringify(result)).not.toContain("/synthetic/private-source");
    expect(JSON.stringify(result)).not.toContain("relativePath");
    expect(await readFile(file, "utf8")).toBe(original);
    await expectLoaderStatus(root, "available");
  });

  it("distinguishes a missing import from a malformed import without returning private contents", async () => {
    expect(await readRecruitingDashboard(root)).toEqual({ status: "missing", snapshot: null });
    await expectLoaderStatus(root, "missing");
    await writeFile(file, "{private-source-marker", { mode: 0o600 });
    expect(await readRecruitingDashboard(root)).toEqual({ status: "invalid", snapshot: null });
    await expectLoaderStatus(root, "invalid");
  });

  it("rejects unsafe event links and invalid evidence references", async () => {
    const snapshot = recruitingSnapshotFixture();
    snapshot.manifest.firms[0]!.events[0]!.url = "javascript:alert(1)";
    await writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
    expect((await readRecruitingDashboard(root)).status).toBe("invalid");
    snapshot.manifest.firms[0]!.events[0]!.url = null;
    snapshot.manifest.firms[0]!.deadline.evidenceIds = ["missing-evidence"];
    await writeFile(file, JSON.stringify(snapshot));
    expect((await readRecruitingDashboard(root)).status).toBe("invalid");
  });

  it("does not expose non-HTTP or credential-bearing evidence locators as links", async () => {
    const snapshot = recruitingSnapshotFixture();
    for (const locator of [
      "file:///private/secret",
      "javascript:alert(1)",
      "https://name:password@example.test",
    ]) {
      snapshot.manifest.evidence[1]!.locator = locator;
      await writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
      const result = await readRecruitingDashboard(root);
      expect(result.status).toBe("available");
      expect(result.snapshot?.manifest.evidence[1]?.url).toBeNull();
      expect(JSON.stringify(result)).not.toContain(locator);
    }
  });

  it("matches the CLI when rejecting symlink files and shared permissions", async () => {
    const target = path.join(root, "target.json");
    await writeFile(target, JSON.stringify(recruitingSnapshotFixture()), { mode: 0o600 });
    await symlink(target, file);
    await expectLoaderStatus(root, "invalid");
    await rm(file);
    await writeFile(file, JSON.stringify(recruitingSnapshotFixture()), { mode: 0o600 });
    await chmod(file, 0o644);
    await expectLoaderStatus(root, "invalid");
  });

  it("rejects symlink directories and roots", async () => {
    const target = path.join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await rm(path.join(root, "recruiting"), { recursive: true });
    await symlink(target, path.join(root, "recruiting"));
    await expectLoaderStatus(root, "invalid");
    const rootAlias = path.join(root, "alias");
    await symlink(target, rootAlias);
    await expectLoaderStatus(rootAlias, "invalid");
  });

  it("matches the CLI on unsafe root/directory permissions and hardlinked snapshots", async () => {
    await writeFile(file, JSON.stringify(recruitingSnapshotFixture()), { mode: 0o600 });
    for (const directory of [root, path.dirname(file)]) {
      await chmod(directory, 0o755);
      await expectLoaderStatus(root, "invalid");
      await chmod(directory, 0o700);
    }
    const alias = path.join(root, "linked.json");
    await link(file, alias);
    await expectLoaderStatus(root, "invalid");
    await rm(alias);
    await expectLoaderStatus(root, "available");
  });

  it("matches the CLI at the exact 2 MiB size boundary", async () => {
    const json = JSON.stringify(recruitingSnapshotFixture());
    const maximumBytes = 2 * 1024 * 1024;
    await writeFile(file, json.padEnd(maximumBytes, " "), { mode: 0o600 });
    await expectLoaderStatus(root, "available");
    await writeFile(file, json.padEnd(maximumBytes + 1, " "));
    await expectLoaderStatus(root, "invalid");
  });
});
