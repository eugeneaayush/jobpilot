import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeDataSchema } from "@jobpilot/contracts/resume";
import { generateDraftPdf } from "./document";
import { documentPipelineInputs } from "./local-tools/pipeline-config";
import { localToolsPython } from "./local-tools/runner";
import { localToolSourceHash } from "./yaml.structure";
import { expect, test } from "bun:test";

const data = resumeDataSchema.parse({
  basics: { name: "Synthetic Candidate", email: "synthetic@example.com" },
  education: [{ id: "edu-1", school: "Synthetic School", degree: "MBA / MS", details: [] }],
  experience: [
    {
      id: "job-1",
      company: "Example Co",
      title: "Analyst",
      start: "2023",
      bullets: ["Analyzed financial statements for a $12M portfolio"],
    },
  ],
});

test.skipIf(!existsSync(localToolsPython()))(
  "RenderCV persists exact source mapping and detects immutable mapping corruption",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jobpilot-renderer-"));
    const previous = process.env.JOBPILOT_PERSONAL_ROOT;
    process.env.JOBPILOT_PERSONAL_ROOT = root;
    try {
      const options = { renderer: "rendercv-classic" as const, userId: crypto.randomUUID() };
      const generated = await generateDraftPdf(data, root, options);
      expect(generated.template).toBe("rendercv-classic");
      expect(generated.rendererConfigHash).toBe(
        documentPipelineInputs("rendercv-classic").rendererConfigHash,
      );
      expect(generated.status).toBe("draft");
      expect(generated.renderQa).toBe("required");
      const reference = generated.rendererMapping!;
      const bytes = await readFile(reference.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(reference.sha256);
      expect(bytes.length).toBe(reference.bytes);
      expect((await stat(reference.path)).mode & 0o777).toBe(0o600);
      const mapping = JSON.parse(bytes.toString());
      expect(mapping.source).toEqual(generated.data);
      expect(mapping.sourceSha256).toBe(localToolSourceHash(generated.data));
      expect(mapping.source.experience[0].end).toBeUndefined();
      expect(mapping.source.education[0].degree).toBe("MBA / MS");
      expect(mapping.source.experience[0].id).toBe("job-1");
      expect(JSON.parse(await readFile(generated.manifestPath, "utf8")).rendererMapping).toEqual(
        reference,
      );
      expect((await readFile(generated.path)).subarray(0, 4).toString()).toBe("%PDF");
      await writeFile(reference.path, "synthetic corruption");
      await expect(generateDraftPdf(data, root, options)).rejects.toThrow(
        "Frozen renderer mapping mismatch",
      );
      expect(await readFile(reference.path, "utf8")).toBe("synthetic corruption");
    } finally {
      if (previous === undefined) delete process.env.JOBPILOT_PERSONAL_ROOT;
      else process.env.JOBPILOT_PERSONAL_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
