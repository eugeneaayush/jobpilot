import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EMPTY_RESUME_DATA } from "@jobpilot/contracts/resume";
import { type DocumentManifest, freezeDocumentProvenance } from "./document";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { expect, test } from "bun:test";

async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "jobpilot-document-sidecar-"));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function provenance(directory: string): Omit<DocumentManifest, "manifestPath"> {
  return {
    ...documentPipelineInputs("cbs-letter-times"),
    path: join(directory, `${"a".repeat(64)}.pdf`),
    sha256: "a".repeat(64),
    bytes: 100,
    sourceDigest: "b".repeat(64),
    status: "draft",
    conflicts: [],
    renderQa: "required",
    template: "cbs-letter-times",
    rendererVersion: "4.5.1",
    rendererConfigHash: "a".repeat(64),
    verifierVersion: "1",
    generatedAt: "2026-09-16T12:00:00.000Z",
    data: structuredClone(EMPTY_RESUME_DATA),
    tailoringMode: "extractive",
    proposalHash: null,
    pageCount: 1,
    maxPages: 1,
    pageLimitExceeded: false,
    docx: { status: "unavailable", reason: "Synthetic fixture" },
  };
}

test("same PDF bytes retain distinct immutable source and review provenance", async () =>
  temporary(async (directory) => {
    const first = await freezeDocumentProvenance(directory, provenance(directory));
    const firstBytes = await readFile(first.manifestPath);
    const revised = await freezeDocumentProvenance(directory, {
      ...provenance(directory),
      sourceDigest: "c".repeat(64),
      proposalHash: "d".repeat(64),
      tailoringMode: "reviewed_rewrite",
    });
    expect(first.sha256).toBe(revised.sha256);
    expect(first.path).toBe(revised.path);
    expect(first.manifestPath).not.toBe(revised.manifestPath);
    expect(await readFile(first.manifestPath)).toEqual(firstBytes);
    for (const artifact of [first, revised]) {
      const bytes = await readFile(artifact.manifestPath);
      expect(basename(artifact.manifestPath)).toBe(
        `${createHash("sha256").update(bytes).digest("hex")}.manifest.json`,
      );
      const { manifestPath: _reference, ...payload } = artifact;
      expect(JSON.parse(bytes.toString())).toEqual(payload);
      expect((await stat(artifact.manifestPath)).mode & 0o777).toBe(0o600);
    }
  }));

test("identical provenance is idempotent and never writes a legacy PDF-hash sidecar", async () =>
  temporary(async (directory) => {
    const payload = provenance(directory);
    const legacy = join(directory, `${payload.sha256}.json`);
    await writeFile(legacy, "historical reviewed provenance");
    const first = await freezeDocumentProvenance(directory, payload);
    const second = await freezeDocumentProvenance(directory, payload);
    expect(second).toEqual(first);
    expect(await readFile(legacy, "utf8")).toBe("historical reviewed provenance");
  }));

test("concurrent provenance revisions preserve all references without last-write wins", async () =>
  temporary(async (directory) => {
    const payload = provenance(directory);
    const revisions = await Promise.all(
      [payload, { ...payload, sourceDigest: "c".repeat(64) }, payload].map((value) =>
        freezeDocumentProvenance(directory, value),
      ),
    );
    expect(revisions[0]!.manifestPath).toBe(revisions[2]!.manifestPath);
    expect(revisions[0]!.manifestPath).not.toBe(revisions[1]!.manifestPath);
    expect(JSON.parse(await readFile(revisions[0]!.manifestPath, "utf8")).sourceDigest).toBe(
      payload.sourceDigest,
    );
    expect(JSON.parse(await readFile(revisions[1]!.manifestPath, "utf8")).sourceDigest).toBe(
      "c".repeat(64),
    );
  }));

test("an existing corrupt artifact holds instead of replacing historical bytes", async () =>
  temporary(async (directory) => {
    const payload = provenance(directory);
    const hash = createHash("sha256")
      .update(JSON.stringify(payload, null, 2))
      .digest("hex");
    const path = join(directory, `${hash}.manifest.json`);
    await writeFile(path, "synthetic corruption");
    await expect(freezeDocumentProvenance(directory, payload)).rejects.toThrow(
      "Frozen document provenance mismatch",
    );
    expect(await readFile(path, "utf8")).toBe("synthetic corruption");
  }));
