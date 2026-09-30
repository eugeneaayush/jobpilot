import { createHash } from "node:crypto";
import { personalDocumentEditsSchema } from "@jobpilot/contracts/personal-yaml";
import { type ResumeData, resumeDataSchema } from "@jobpilot/contracts/resume";
import { applyReviewedProposal, type ReviewedProposal, tailoringHash } from "./tailoring/proposal";

export function localToolSourceHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function arrayAt(data: ResumeData, pointer: string): unknown[] {
  const keys = pointer.slice(1).split("/");
  let value: unknown = data;
  for (const key of keys) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("Document selection path does not exist");
    value = (value as Record<string, unknown>)[key];
  }
  if (!Array.isArray(value)) throw new Error("Document selection must target an array");
  return value;
}

function setArray(data: ResumeData, pointer: string, selected: unknown[]): void {
  const keys = pointer.slice(1).split("/");
  const field = keys.pop()!;
  let value: unknown = data;
  for (const key of keys) value = (value as Record<string, unknown>)[key];
  (value as Record<string, unknown>)[field] = selected;
}

const ENTRY_ARRAY =
  /^\/(experience|projects|education|skills|publications|awards|certifications)$|^\/sections\/\d+\/entries$/;
const STRING_ARRAY =
  /^\/(experience|projects)\/\d+\/bullets$|^\/education\/\d+\/details$|^\/skills\/\d+\/items$|^\/sections\/\d+\/entries\/\d+\/bullets$/;

export function applyImportedStructure(
  baseValue: ResumeData,
  reviewedValue: ResumeData,
  value: unknown,
  reviewed: ReviewedProposal,
): ResumeData {
  const base = resumeDataSchema.parse(baseValue);
  const edits = personalDocumentEditsSchema.parse(value);
  if (
    edits.baseDataHash !== tailoringHash(base) ||
    edits.sourceSha256 !== localToolSourceHash(base) ||
    edits.sourceDigest !== reviewed.input.sourceDigest ||
    edits.proposalHash !== tailoringHash(reviewed.proposal)
  )
    throw new Error("Imported document selection is stale");
  if (!reviewed.review?.independent)
    throw new Error("Imported document selection requires independent claim review");
  const accepted = applyReviewedProposal(base, reviewed);
  if (tailoringHash(accepted) !== tailoringHash(reviewedValue))
    throw new Error("Document selection must follow this exact reviewed proposal");
  const result = structuredClone(accepted);
  const paths = new Set<string>();
  const selections = edits.operations.map((operation) => {
    if (paths.has(operation.path)) throw new Error("Duplicate document selection path");
    paths.add(operation.path);
    if (!ENTRY_ARRAY.test(operation.path) && !STRING_ARRAY.test(operation.path))
      throw new Error("Unsupported document selection path");
    const source = arrayAt(base, operation.path);
    let indices: number[];
    if (ENTRY_ARRAY.test(operation.path)) {
      const expected = source.map((_, index) => index);
      if (JSON.stringify(operation.before) !== JSON.stringify(expected))
        throw new Error("Entry selection does not match the frozen source indices");
      if (!operation.after.every((index) => typeof index === "number" && index < source.length))
        throw new Error("Entry selection introduces an unknown index");
      indices = operation.after as number[];
    } else {
      if (JSON.stringify(operation.before) !== JSON.stringify(source))
        throw new Error("Bullet selection does not match the frozen source");
      if (new Set(source).size !== source.length)
        throw new Error("Repeated source lines make this selection ambiguous");
      indices = operation.after.map((line) => source.indexOf(line));
      if (indices.some((index) => index < 0))
        throw new Error("Selection cannot introduce new content");
    }
    if (new Set(indices).size !== indices.length || indices.length > source.length)
      throw new Error("Selection cannot duplicate content");
    if (operation.kind === "reorder" && indices.length !== source.length)
      throw new Error("A reorder must preserve every source entry");
    if (operation.kind === "cut" && indices.length >= source.length)
      throw new Error("A cut must remove source content");
    return { path: operation.path, indices };
  });
  for (const parent of selections) {
    if (!ENTRY_ARRAY.test(parent.path)) continue;
    for (const child of selections) {
      if (!child.path.startsWith(`${parent.path}/`)) continue;
      const index = Number(child.path.slice(parent.path.length + 1).split("/")[0]);
      if (!parent.indices.includes(index))
        throw new Error("Cannot edit an entry removed by a parent selection");
    }
  }
  for (const selection of selections.sort(
    (a, b) => b.path.split("/").length - a.path.split("/").length,
  )) {
    const current = arrayAt(result, selection.path);
    setArray(
      result,
      selection.path,
      selection.indices.map((index) => current[index]),
    );
  }
  if (base.experience.length && !result.experience.length)
    throw new Error("A document must retain at least one source employer");
  return resumeDataSchema.parse(result);
}
