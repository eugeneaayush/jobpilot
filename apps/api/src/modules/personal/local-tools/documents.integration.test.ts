import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDraftPdf } from "../document";
import { generateCoverLetter } from "../document/cover-letter";
import { sourceFixture } from "../tailoring/fakes";
import { documentPipelineInputs } from "./pipeline-config";
import { verifyRendererMapping } from "./renderer-mapping";
import { executeLocalTool, localToolsPython } from "./runner";
import { assertVerificationScope } from "./verification-policy";
import { describe, expect, test } from "bun:test";

const python = localToolsPython();
const available = await Bun.file(python).exists();
describe.skipIf(!available)("real local document verification", () => {
  test("experienced CBS page numbering remains inside its explicit footer calibration", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobpilot-cbs-footer-verification-"));
    try {
      const { data } = sourceFixture();
      data.experience = Array.from({ length: 8 }, (_, entry) => ({
        ...data.experience[0]!,
        company: `Synthetic Employer ${entry}`,
        bullets: Array.from(
          { length: 8 },
          (_, bullet) =>
            `Prepared synthetic investment research report ${entry}-${bullet} and reviewed financial statements with the team`,
        ),
      }));
      const document = await generateDraftPdf(data, root, { maxPages: 2 });
      expect(document.pageCount).toBe(2);
      const output = await executeLocalTool(
        {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          operation: "verify_document",
          payload: {
            filename: "document.pdf",
            sha256: document.sha256,
            requiredText: [data.basics.name],
            supportedTerms: [],
            maxPages: 2,
            renderer: "cbs-letter-times",
          },
        },
        { root, executable: python, inputFiles: { "document.pdf": await readFile(document.path) } },
      );
      expect(output.result.status).toBe(Bun.which("pdftotext") ? "passed" : "unavailable");
      expect(output.result.verifierConfigHash).toBe(
        documentPipelineInputs("cbs-letter-times").verifierConfigHash,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("RenderCV generates an immutable mapping and passes API-bound exact-byte verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobpilot-rendercv-verification-"));
    const previous = process.env.JOBPILOT_PERSONAL_ROOT;
    process.env.JOBPILOT_PERSONAL_ROOT = root;
    try {
      const { data } = sourceFixture();
      const userId = crypto.randomUUID();
      const documentRoot = join(root, "storage", userId);
      const document = await generateDraftPdf(data, documentRoot, {
        renderer: "rendercv-classic",
        userId,
      });
      await expect(verifyRendererMapping({ ...document }, documentRoot)).resolves.toBeUndefined();
      const bytes = await readFile(document.path);
      const expected = {
        artifactSha256: document.sha256,
        requiredText: [data.basics.name, data.basics.email!],
        supportedTerms: ["SQL"],
        maxPages: 1 as const,
        renderer: "rendercv-classic",
      };
      const output = await executeLocalTool(
        {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          operation: "verify_document",
          payload: {
            filename: "document.pdf",
            sha256: expected.artifactSha256,
            requiredText: expected.requiredText,
            supportedTerms: expected.supportedTerms,
            maxPages: expected.maxPages,
            renderer: expected.renderer,
          },
        },
        { root: documentRoot, executable: python, inputFiles: { "document.pdf": bytes } },
      );
      expect(output.result.status).toBe(Bun.which("pdftotext") ? "passed" : "unavailable");
      expect(() => assertVerificationScope(output.result, expected)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.JOBPILOT_PERSONAL_ROOT;
      else process.env.JOBPILOT_PERSONAL_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("CBS resume and cover letter preserve contacts and required terms; corruption and missing contacts fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobpilot-verification-"));
    try {
      const { data } = sourceFixture();
      data.basics.email = "synthetic@example.test";
      data.basics.phone = "+1 202 555 0199";
      const resume = await generateDraftPdf(data, root);
      const letter = await generateCoverLetter(
        data,
        { title: "Investment Analyst", company: "Fixture Employer" },
        root,
      );
      for (const document of [resume, letter]) {
        const bytes = await readFile(document.path);
        const payload = {
          filename: "document.pdf",
          sha256: document.sha256,
          requiredText: [data.basics.name, data.basics.email, data.basics.phone],
          supportedTerms: [],
          maxPages: 1 as const,
          renderer: document === resume ? "cbs-letter-times" : "cbs-cover-letter",
        };
        const check = async (overrides: Partial<typeof payload> = {}) =>
          (
            await executeLocalTool(
              {
                protocolVersion: 1,
                requestId: crypto.randomUUID(),
                operation: "verify_document",
                payload: { ...payload, ...overrides },
              },
              { root, executable: python, inputFiles: { "document.pdf": bytes } },
            )
          ).result;
        const good = await check();
        expect(good.artifactSha256).toBe(document.sha256);
        expect(good.verifierConfigHash).toBe(
          documentPipelineInputs("cbs-letter-times").verifierConfigHash,
        );
        expect(good.status).toBe(Bun.which("pdftotext") ? "passed" : "unavailable");
        expect((await check({ requiredText: ["Missing Person"] })).status).toBe("failed");
        expect((await check({ sha256: "0".repeat(64) })).status).toBe("failed");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
