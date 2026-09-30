import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonalDocumentVerification } from "@jobpilot/contracts/personal-local-tools";
import { privateArtifactRoot, readPrivateArtifact } from "../persistence-policy";
import { runLocalTool } from "./runner";
import { assertVerificationScope } from "./verification-policy";

const DOCUMENT_VERIFIER_VERSION = "1";

export async function verifyDocumentForUser(
  userId: string,
  bytes: Uint8Array,
  options: {
    requiredText: string[];
    supportedTerms?: string[];
    maxPages: 1 | 2;
    renderer: string;
    signal?: AbortSignal;
  },
): Promise<PersonalDocumentVerification> {
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const requiredText = options.requiredText.filter((text) => text.trim());
  const supportedTerms = options.supportedTerms ?? [];
  let report: PersonalDocumentVerification;
  try {
    const output = await runLocalTool(
      userId,
      "verify_document",
      {
        filename: "document.pdf",
        sha256: artifactSha256,
        requiredText,
        supportedTerms,
        maxPages: options.maxPages,
        renderer: options.renderer,
      },
      { inputFiles: { "document.pdf": bytes }, signal: options.signal },
    );
    report = output.result;
    assertVerificationScope(report, {
      artifactSha256,
      renderer: options.renderer,
      requiredText,
      supportedTerms,
      maxPages: options.maxPages,
    });
  } catch {
    report = {
      artifactSha256,
      verifierVersion: DOCUMENT_VERIFIER_VERSION,
      renderer: options.renderer,
      status: "unavailable",
      pageCount: null,
      extractedCharacters: 0,
      checks: [
        {
          code: "local_tools_unavailable",
          status: "unavailable",
          message:
            "Document checks could not complete; verify local tools and inspect the retained artifact.",
        },
      ],
    };
  }
  const content = Buffer.from(JSON.stringify(report, null, 2));
  const reportHash = createHash("sha256").update(content).digest("hex");
  const root = privateArtifactRoot(userId);
  const directory = path.join(root, "document-checks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${reportHash}.json`);
  await writeFile(filename, content, { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  if (!content.equals(await readPrivateArtifact(filename, root)))
    throw new Error("Document report integrity mismatch");
  return report;
}
