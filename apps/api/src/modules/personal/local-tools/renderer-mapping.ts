import { z } from "zod/v4";
import { conflict } from "@/common/errors";
import { readPrivateArtifact } from "../persistence-policy";
import { sha256 } from "../runtime";
import { localToolSourceHash } from "../yaml.structure";

const referenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(16_000_000),
});

export function assertRendererMapping(value: unknown, source: unknown, configHash: string) {
  const mapping = z
    .object({
      version: z.literal(1),
      sourceSha256: z.string(),
      configSha256: z.literal(configHash),
      source: z.unknown(),
      mapping: z.array(z.unknown()),
    })
    .safeParse(value);
  if (
    !mapping.success ||
    mapping.data.sourceSha256 !== localToolSourceHash(source) ||
    localToolSourceHash(mapping.data.source) !== mapping.data.sourceSha256
  )
    throw new Error("Renderer mapping does not preserve the accepted source and configuration");
}

export async function verifyRendererMapping(
  document: Record<string, unknown>,
  allowedRoot: string,
) {
  if (document.template !== "rendercv-classic") return;
  try {
    const reference = referenceSchema.parse(document.rendererMapping);
    const bytes = await readPrivateArtifact(reference.path, allowedRoot);
    if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256)
      throw new Error("Mapping artifact bytes changed");
    if (typeof document.rendererConfigHash !== "string") throw new Error("Missing configuration");
    assertRendererMapping(JSON.parse(bytes.toString()), document.data, document.rendererConfigHash);
  } catch {
    throw conflict("Frozen renderer mapping is unavailable or changed; regenerate and review");
  }
}
