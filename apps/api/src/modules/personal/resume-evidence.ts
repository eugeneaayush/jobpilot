import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { IntakeResult } from "./intake";

type IntakeConflict = IntakeResult["manifest"]["conflicts"][number];

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const citationSchema = z
  .object({
    source: z.string().min(1),
    locator: z.string().min(1),
    quote: z.string().min(1),
    sourceSha256: hashSchema.optional(),
  })
  .strict();
const editSchema = z
  .object({
    id: z.string().min(1),
    pointer: z.string().startsWith("/"),
    operation: z.enum(["replace", "omit"]),
    expectedValue: z.json().optional(),
    expectedValueSha256: hashSchema.optional(),
    value: z.json().optional(),
    citation: citationSchema,
    resolvesConflictIds: z.array(hashSchema).default([]),
  })
  .strict()
  .superRefine((edit, context) => {
    if (edit.expectedValue === undefined && edit.expectedValueSha256 === undefined)
      context.addIssue({
        code: "custom",
        message: "An exact expected prior value or hash is required",
      });
    if (edit.operation === "replace" && edit.value === undefined)
      context.addIssue({ code: "custom", message: "Replacement value is required" });
    if (edit.operation === "omit" && edit.value !== undefined)
      context.addIssue({ code: "custom", message: "Omission must not carry a replacement value" });
  });
const classificationSchema = z
  .object({
    id: z.string().min(1),
    conflictId: hashSchema,
    classification: z.enum(["editorial", "structural", "substantive", "unsupported"]),
    rationale: z.string().min(1),
    citation: citationSchema.extend({ sourceSha256: hashSchema }),
  })
  .strict();
export const resumeResolutionOverlaySchema = z
  .object({
    sourceSha256: hashSchema,
    edits: z.array(editSchema).default([]),
    classifications: z.array(classificationSchema).default([]),
  })
  .strict();
export type ResumeResolutionOverlay = z.input<typeof resumeResolutionOverlaySchema>;
type Json = z.infer<ReturnType<typeof z.json>>;
type Citation = z.infer<typeof citationSchema>;
interface ConflictReview {
  id: string;
  conflict: IntakeConflict;
  classification: "editorial" | "structural" | "substantive" | "unsupported" | "unclassified";
  status: "resolved" | "unresolved";
  resolutionId: string | null;
  rationale: string;
  citation: Citation | null;
}
export interface ResumeEvidenceResult {
  document: Json;
  originalDocument: Json;
  conflicts: ConflictReview[];
  unresolvedConflicts: ConflictReview[];
  sourceEvidenceReady: boolean;
  provenance: {
    sourceSha256: string;
    originalDocumentSha256: string;
    derivedDocumentSha256: string;
    overlaySha256: string | null;
    changes: {
      id: string;
      pointer: string;
      operation: "replace" | "omit";
      before: Json;
      after?: Json;
      beforeSha256: string;
      afterSha256: string | null;
      citation: Citation;
      resolvesConflictIds: string[];
    }[];
    classifications: z.infer<typeof classificationSchema>[];
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
function omitAbsentOptionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitAbsentOptionalProperties);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, omitAbsentOptionalProperties(child)]),
    );
  return value;
}
export function evidenceValueHash(value: unknown): string {
  const parsed = z.json().parse(value);
  return createHash("sha256")
    .update(JSON.stringify(canonical(parsed)))
    .digest("hex");
}
export function evidenceConflictId(conflict: IntakeConflict): string {
  return evidenceValueHash(conflict);
}
function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part)))
    throw new Error("Unsafe JSON pointer");
  return parts;
}
function child(value: Json, key: string): Json {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
    throw new Error("JSON pointer does not identify an existing value");
  if (Array.isArray(value)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
      throw new Error("Invalid array index in JSON pointer");
    return value[Number(key)] as Json;
  }
  return value[key] as Json;
}
function atPointer(value: Json, parts: string[]): Json {
  return parts.reduce<Json>((current, key) => child(current, key), value);
}
function typographyEquivalent(conflict: IntakeConflict): boolean {
  if (
    conflict.kind !== "source_difference" ||
    conflict.values.length < 2 ||
    !conflict.values.every((value) => typeof value === "string")
  )
    return false;
  const values = conflict.values as string[];
  const spaces = values.map((value) => value.replace(/\s+/gu, " ").trim());
  if (spaces.every((value) => value === spaces[0])) return true;
  // Numeric, currency, date, and range changes always require an explicit evidence decision.
  if (values.some((value) => /[\d$€£¥%]/u.test(value))) return false;
  const words = values.map(
    (value) =>
      value
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{M}]+/gu)
        ?.join(" ") ?? "",
  );
  return !!words[0] && words.every((value) => value === words[0]);
}
function descendingPointers(a: { parts: string[] }, b: { parts: string[] }): number {
  for (let i = 0; i < Math.min(a.parts.length, b.parts.length); i++) {
    const left = a.parts[i] ?? "";
    const right = b.parts[i] ?? "";
    if (left === right) continue;
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(right) - Number(left);
    return right.localeCompare(left);
  }
  return b.parts.length - a.parts.length;
}

export function resolveResumeEvidence(input: {
  document: unknown;
  sourceSha256: string;
  conflicts: IntakeConflict[];
  overlay?: ResumeResolutionOverlay;
}): ResumeEvidenceResult {
  const sourceSha256 = hashSchema.parse(input.sourceSha256);
  // ResumeData schemas can retain absent optional keys as undefined. Their JSON representation
  // omits those keys; array holes and non-JSON values must still fail validation.
  const originalDocument = structuredClone(
    z.json().parse(omitAbsentOptionalProperties(input.document)),
  );
  const document = structuredClone(originalDocument);
  const overlay =
    input.overlay === undefined ? undefined : resumeResolutionOverlaySchema.parse(input.overlay);
  if (overlay && overlay.sourceSha256 !== sourceSha256)
    throw new Error("Resolution overlay source hash mismatch");
  const reviews: ConflictReview[] = input.conflicts.map((conflict) => {
    const equivalent = typographyEquivalent(conflict);
    return {
      id: evidenceConflictId(conflict),
      conflict: structuredClone(conflict),
      classification: equivalent ? "editorial" : "unclassified",
      status: equivalent ? "resolved" : "unresolved",
      resolutionId: null,
      rationale: equivalent
        ? "Same ordered words without numeric content, or identical text after whitespace normalization; complete comparison retained"
        : "No explicit evidence decision resolves this source comparison",
      citation: null,
    };
  });
  const byId = new Map(reviews.map((review) => [review.id, review]));
  if (byId.size !== reviews.length) throw new Error("Duplicate conflict digest in inventory");
  const decisions = new Set<string>();
  const resolutionIds = new Set<string>();
  function registerResolutionId(id: string) {
    if (resolutionIds.has(id)) throw new Error("Duplicate resolution ID");
    resolutionIds.add(id);
  }
  function claimConflict(id: string): ConflictReview {
    const review = byId.get(id);
    if (!review) throw new Error("Resolution references an unknown or changed conflict");
    if (decisions.has(id)) throw new Error("Multiple decisions target the same conflict");
    decisions.add(id);
    return review;
  }
  for (const classification of overlay?.classifications ?? []) {
    registerResolutionId(classification.id);
    const review = claimConflict(classification.conflictId);
    review.classification = classification.classification;
    review.status = ["editorial", "structural"].includes(classification.classification)
      ? "resolved"
      : "unresolved";
    review.resolutionId = classification.id;
    review.rationale = classification.rationale;
    review.citation = structuredClone(classification.citation);
  }
  const edits = (overlay?.edits ?? []).map((edit) => {
    registerResolutionId(edit.id);
    const parts = pointerParts(edit.pointer);
    const before = atPointer(originalDocument, parts);
    const beforeSha256 = evidenceValueHash(before);
    if (edit.expectedValue !== undefined && evidenceValueHash(edit.expectedValue) !== beforeSha256)
      throw new Error(`Expected prior value mismatch: ${edit.pointer}`);
    if (edit.expectedValueSha256 !== undefined && edit.expectedValueSha256 !== beforeSha256)
      throw new Error(`Expected prior hash mismatch: ${edit.pointer}`);
    for (const id of edit.resolvesConflictIds) {
      const review = claimConflict(id);
      review.status = "resolved";
      review.resolutionId = edit.id;
      review.citation = structuredClone(edit.citation);
      review.rationale = `Explicit ${edit.operation} overlay checked against the original value and source hash`;
    }
    return { edit, parts, before, beforeSha256 };
  });
  for (let i = 0; i < edits.length; i++)
    for (let j = i + 1; j < edits.length; j++) {
      const a = edits[i]?.parts ?? [];
      const b = edits[j]?.parts ?? [];
      if (a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]))
        throw new Error("Overlapping JSON pointer edits are ambiguous");
    }
  for (const { edit, parts } of [...edits].sort(descendingPointers)) {
    const parent = atPointer(document, parts.slice(0, -1));
    const key = parts.at(-1) ?? "";
    if (!parent || typeof parent !== "object")
      throw new Error("JSON pointer parent is not an object");
    if (Array.isArray(parent)) {
      if (edit.operation === "omit") parent.splice(Number(key), 1);
      else parent[Number(key)] = structuredClone(edit.value) as Json;
    } else if (edit.operation === "omit") delete parent[key];
    else parent[key] = structuredClone(edit.value) as Json;
  }
  const unresolvedConflicts = reviews.filter((review) => review.status === "unresolved");
  return {
    document,
    originalDocument,
    conflicts: reviews,
    unresolvedConflicts,
    sourceEvidenceReady: unresolvedConflicts.length === 0,
    provenance: {
      sourceSha256,
      originalDocumentSha256: evidenceValueHash(originalDocument),
      derivedDocumentSha256: evidenceValueHash(document),
      overlaySha256: overlay ? evidenceValueHash(overlay) : null,
      changes: edits.map(({ edit, before, beforeSha256 }) => ({
        id: edit.id,
        pointer: edit.pointer,
        operation: edit.operation,
        before: structuredClone(before),
        ...(edit.operation === "replace" ? { after: structuredClone(edit.value) } : {}),
        beforeSha256,
        afterSha256: edit.operation === "replace" ? evidenceValueHash(edit.value) : null,
        citation: structuredClone(edit.citation),
        resolvesConflictIds: [...edit.resolvesConflictIds],
      })),
      classifications: structuredClone(overlay?.classifications ?? []),
    },
  };
}
