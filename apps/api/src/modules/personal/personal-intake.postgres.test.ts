import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import {
  createPersonalTestDatabase,
  type PersonalTestDatabase,
  personalFixture,
} from "./persistence-test-fixtures";
import { PersonalService } from "./personal.service";
import { PersonalReadinessService } from "./readiness.service";
import { evidenceConflictId } from "./resume-evidence";
import { objectValue, sha256 } from "./runtime";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal intake resolution integration", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });

  it("retains original sources and added audit conflicts while versioning explicit resolutions", async () => {
    const f = await personalFixture(db);
    const service = new PersonalService(db.prisma, new PersonalReadinessService(db.prisma));
    const source = resumeDataSchema.parse({ basics: { name: "Synthetic Candidate" } });
    const sourceText = JSON.stringify(source);
    const sourceJsonPath = join(db.root, "master.json");
    const sourceDocxPath = join(db.root, "master.docx");
    await writeFile(sourceJsonPath, sourceText);
    await mkdir(join(db.root, "word"));
    await writeFile(
      join(db.root, "word/document.xml"),
      "<w:document><w:p><w:r><w:t>Synthetic Candidate</w:t></w:r></w:p></w:document>",
    );
    expect(
      await Bun.spawn(["zip", "-q", sourceDocxPath, "word/document.xml"], { cwd: db.root }).exited,
    ).toBe(0);
    const originalDocx = await readFile(sourceDocxPath);
    const auditConflict = {
      kind: "audit_warning",
      source: "synthetic-audit",
      pointer: "/basics/name",
      message: "Name requires explicit confirmation",
      values: ["Synthetic Candidate"],
    };
    const config = {
      sourceJsonPath,
      sourceDocxPath,
      intakeConflicts: [auditConflict],
      account: { userId: f.user.id },
    };
    await writeFile(join(db.root, "runtime.json"), JSON.stringify(config));
    const first = await service.intake(f.user.id);
    expect(first.conflicts).toEqual(["Name requires explicit confirmation (/basics/name)"]);
    const overlay = {
      sourceSha256: sha256(sourceText),
      edits: [
        {
          id: "confirm-name",
          pointer: "/basics/name",
          operation: "replace",
          expectedValue: "Synthetic Candidate",
          value: "Synthetic Candidate",
          citation: {
            source: "explicit-user",
            locator: "synthetic-confirmation",
            quote: "Synthetic Candidate",
          },
          resolvesConflictIds: [evidenceConflictId(auditConflict)],
        },
      ],
    };
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({ ...config, resumeResolutionOverlay: overlay }),
    );
    const resolved = await service.intake(f.user.id);
    expect(resolved.resumeId).not.toBe(first.resumeId);
    expect(resolved.conflicts).toEqual([]);
    expect((await service.intake(f.user.id)).resumeId).toBe(resolved.resumeId);
    const evidence = await db.prisma.personalResumeEvidence.findFirstOrThrow({
      where: { resumeId: resolved.resumeId },
    });
    const details = objectValue(evidence.details);
    expect(objectValue(details.originalManifest).conflicts).toEqual([]);
    expect(objectValue(details.manifest).conflicts).toEqual([auditConflict]);
    expect(details.resolution).toMatchObject({
      sourceEvidenceReady: true,
      conflicts: [{ status: "resolved", conflict: auditConflict }],
      provenance: { changes: [{ id: "confirm-name" }] },
    });
    expect(JSON.parse(await readFile(String(details.manifestPath), "utf8"))).toEqual(
      details.manifest,
    );
    expect(await readFile(sourceJsonPath, "utf8")).toBe(sourceText);
    expect(await readFile(sourceDocxPath)).toEqual(originalDocx);
    expect(objectValue(details.preview).readiness).toBeUndefined();
    await writeFile(
      join(db.root, "runtime.json"),
      JSON.stringify({
        ...config,
        resumeResolutionOverlay: { ...overlay, sourceSha256: "0".repeat(64) },
      }),
    );
    await expect(service.intake(f.user.id)).rejects.toThrow("source hash mismatch");
  });
});
