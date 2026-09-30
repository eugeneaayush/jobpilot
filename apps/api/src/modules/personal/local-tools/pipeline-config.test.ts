import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import { manifestHash } from "../persistence-policy";
import { preparationPreviewHash } from "../preparation-policy";
import { localToolSourceHash } from "../yaml.structure";
import {
  assertRendererConfiguration,
  documentPipelineInputs,
  documentPipelineMatches,
  verifierPipelineMatches,
} from "./pipeline-config";
import { executeLocalTool, localToolsPython } from "./runner";
import { afterEach, describe, expect, test } from "bun:test";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const data = resumeDataSchema.parse({
  basics: { name: "Synthetic Example", email: "synthetic@example.com" },
});
const record = {
  id: "synthetic-record",
  identity: "synthetic-identity",
  details: { posting: { contentHash: "a".repeat(64) } },
};
const evidence = { id: "synthetic-evidence", sourceHash: "b".repeat(64), details: {} };

function context(settings: ReturnType<typeof personalSettingsSchema.parse>) {
  return {
    documentEdits: null,
    posting: "a".repeat(64),
    settings,
    evidence,
    data,
    screeningAnswers: null,
    attachmentRequirements: null,
    attachments: [],
  };
}

describe("document pipeline configuration", () => {
  test.skipIf(!existsSync(localToolsPython()))(
    "real locked Python export agrees with the API's exact allowed config",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "jobpilot-pipeline-config-"));
      directories.push(root);
      const output = await executeLocalTool(
        {
          protocolVersion: 1,
          requestId: "pipeline-config",
          operation: "export_resume_yaml",
          payload: { resume: data },
        },
        { root, executable: localToolsPython() },
      );
      expect(output.result.configSha256).toBe(
        documentPipelineInputs("rendercv-classic").rendererConfigHash,
      );
      expect(() => assertRendererConfiguration("rendercv-classic", output.result)).not.toThrow();
    },
  );

  test("dependency and template changes cannot reuse the current renderer hash", () => {
    const config = {
      renderer: "rendercv-classic",
      design: {
        theme: "classic",
        page: { size: "us-letter", show_footer: false, show_top_note: false },
      },
      version: "2.8",
      mappingVersion: 1,
      typstVersion: "0.15.0",
      fontsVersion: "0.5.1",
      fontFamilies: ["Source Sans 3", "Font Awesome 7", "Noto Sans"],
    };
    const accepted = documentPipelineInputs("rendercv-classic");
    expect(localToolSourceHash(config)).toBe(accepted.rendererConfigHash);
    for (const change of [
      { typstVersion: "0.15.1" },
      { fontsVersion: "0.5.2" },
      { version: "2.9" },
      { mappingVersion: 2 },
      { design: { ...config.design, theme: "custom" } },
    ]) {
      const configSha256 = localToolSourceHash({ ...config, ...change });
      expect(() =>
        assertRendererConfiguration("rendercv-classic", { rendererVersion: "2.8", configSha256 }),
      ).toThrow("configuration");
    }
  });

  test("preparation binds renderer dependency and verifier configuration hashes", () => {
    const settings = personalSettingsSchema.parse({ resumeRenderer: "rendercv-classic" });
    const pipeline = documentPipelineInputs("rendercv-classic");
    const key = preparationPreviewHash(record, settings, evidence, data);
    const inputs = { ...pipeline, ...context(settings) };
    expect(key).toBe(manifestHash(inputs));
    for (const change of [
      { rendererConfigHash: "c".repeat(64) },
      { verifierConfigHash: "d".repeat(64) },
      { verifierVersion: "2" },
    ]) {
      expect(manifestHash({ ...inputs, ...change })).not.toBe(key);
    }
    expect(key).not.toBe(
      manifestHash({
        documentPipelineVersion: "private-documents-v2",
        renderer: "rendercv-classic",
        rendererVersion: "2.8",
        verifierVersion: "1",
        ...context(settings),
      }),
    );
  });

  test("CBS remains the explicit default with a distinct template configuration", () => {
    const settings = personalSettingsSchema.parse({});
    const defaultKey = preparationPreviewHash(record, settings, evidence, data);
    expect(defaultKey).toBe(
      manifestHash({ ...documentPipelineInputs("cbs-letter-times"), ...context(settings) }),
    );
    expect(documentPipelineInputs("cbs-letter-times").rendererConfigHash).not.toBe(
      documentPipelineInputs("rendercv-classic").rendererConfigHash,
    );
    expect(documentPipelineInputs("cbs-letter-times").rendererVersion).toBe("4.5.1");
  });

  test("all readiness pipelines hold historical or altered renderer and verifier metadata", () => {
    for (const renderer of ["cbs-letter-times", "cbs-cover-letter", "rendercv-classic"] as const) {
      const pipeline = documentPipelineInputs(renderer);
      expect(documentPipelineMatches(pipeline, renderer)).toBe(true);
      expect(verifierPipelineMatches(pipeline, renderer)).toBe(true);
      for (const field of [
        "documentPipelineVersion",
        "rendererVersion",
        "rendererConfigHash",
        "verifierVersion",
        "verifierConfigHash",
      ])
        expect(documentPipelineMatches({ ...pipeline, [field]: "stale" }, renderer)).toBe(false);
      for (const verifierConfigHash of [undefined, "0".repeat(64)])
        expect(verifierPipelineMatches({ ...pipeline, verifierConfigHash }, renderer)).toBe(false);
      expect(documentPipelineMatches({}, renderer)).toBe(false);
    }
  });
});
