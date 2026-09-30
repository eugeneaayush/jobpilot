import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import { sha256 } from "../runtime";
import { localToolSourceHash } from "../yaml.structure";
import { documentPipelineInputs } from "./pipeline-config";
import { assertRendererMapping, verifyRendererMapping } from "./renderer-mapping";
import { describe, expect, test } from "bun:test";

const data = resumeDataSchema.parse({ basics: { name: "Synthetic Candidate" } });
const configHash = documentPipelineInputs("rendercv-classic").rendererConfigHash;
const mapping = () => ({
  version: 1,
  sourceSha256: localToolSourceHash(data),
  configSha256: configHash,
  source: data,
  mapping: [],
});

describe("frozen RenderCV mapping evidence", () => {
  test("source, configuration and mapping version must all remain accepted", () => {
    expect(() => assertRendererMapping(mapping(), data, configHash)).not.toThrow();
    for (const change of [
      { version: 2 },
      { sourceSha256: "a".repeat(64) },
      { configSha256: "b".repeat(64) },
      { source: { ...data, basics: { name: "Invented Candidate" } } },
      { mapping: undefined },
    ]) {
      expect(() => assertRendererMapping({ ...mapping(), ...change }, data, configHash)).toThrow();
    }
  });

  test("binding and live checks require exact private mapping bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobpilot-frozen-mapping-"));
    const outside = await mkdtemp(join(tmpdir(), "jobpilot-external-mapping-"));
    try {
      const bytes = Buffer.from(JSON.stringify(mapping()));
      const path = join(root, "mapping.json");
      const outsidePath = join(outside, "mapping.json");
      await writeFile(path, bytes, { mode: 0o600 });
      await writeFile(outsidePath, bytes, { mode: 0o600 });
      const document = {
        template: "rendercv-classic",
        data,
        rendererConfigHash: configHash,
        rendererMapping: { path, sha256: sha256(bytes), bytes: bytes.length },
      };
      await expect(verifyRendererMapping(document, root)).resolves.toBeUndefined();
      for (const change of [
        { rendererMapping: undefined },
        { rendererMapping: { ...document.rendererMapping, path: outsidePath } },
        { rendererMapping: { ...document.rendererMapping, bytes: bytes.length + 1 } },
        { rendererMapping: { ...document.rendererMapping, sha256: "c".repeat(64) } },
        { rendererConfigHash: "d".repeat(64) },
        { data: { ...data, basics: { name: "Invented Candidate" } } },
      ]) {
        await expect(verifyRendererMapping({ ...document, ...change }, root)).rejects.toThrow(
          "Frozen renderer mapping",
        );
      }
      await writeFile(path, "changed bytes");
      await expect(verifyRendererMapping(document, root)).rejects.toThrow(
        "Frozen renderer mapping",
      );
      await expect(
        verifyRendererMapping({ template: "cbs-letter-times" }, root),
      ).resolves.toBeUndefined();
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
