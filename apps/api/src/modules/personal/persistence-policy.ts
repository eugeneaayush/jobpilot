import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { PERSONAL_ATTEMPT_MODES } from "@jobpilot/contracts/personal-attempt";
import { personalCampaignCreateSchema } from "@jobpilot/contracts/personal-campaign";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { z } from "zod";
import { conflict } from "@/common/errors";

const policySchema = z.object({
  enabled: z.literal(true),
  mode: z.enum(PERSONAL_ATTEMPT_MODES),
  approvalPolicy: z.literal("per-application-v1").optional(),
  dailyCap: z.number().int().positive().max(1000),
  maxApplications: z.number().int().positive().max(10000),
  timezone: z.string().min(1),
  policyVersion: z.string().min(1),
  roleScope: personalCampaignCreateSchema.shape.roleScope,
  tracks: personalCampaignCreateSchema.shape.tracks.optional(),
  sources: personalCampaignCreateSchema.shape.sources.optional(),
});

export function readAttemptPolicy(config: unknown) {
  const parsed = z.object({ personal: policySchema }).safeParse(config);
  if (!parsed.success) throw conflict("An explicit enabled personal campaign policy is required.");
  if (
    parsed.data.personal.mode !== "offline" &&
    parsed.data.personal.approvalPolicy !== "per-application-v1"
  )
    throw conflict(
      "Live campaigns require per-application approval; migrate and relaunch the campaign",
    );
  if (
    parsed.data.personal.roleScope &&
    (!parsed.data.personal.tracks || !parsed.data.personal.sources)
  )
    throw conflict("A scoped campaign requires explicit recruiting tracks and sources.");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: parsed.data.personal.timezone }).format();
  } catch {
    throw conflict("Campaign policy timezone is invalid.");
  }
  return parsed.data.personal;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortedJson(v)]),
    );
  }
  return value;
}

export function manifestHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(sortedJson(value)))
    .digest("hex");
}

export function policyDay(timezone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join("-");
}

export function privateArtifactRoot(userId: string): string {
  const root = process.env.JOBPILOT_PERSONAL_ROOT;
  if (!root || !isAbsolute(root) || !/^[a-f0-9-]{36}$/i.test(userId))
    throw conflict("A private user artifact root is required.");
  return join(root, "storage", userId);
}

export async function readPrivateArtifact(path: string, allowedRoot: string): Promise<Buffer> {
  if (!isAbsolute(path) || !isAbsolute(allowedRoot))
    throw conflict("Evidence requires an absolute private artifact path.");
  try {
    const [root, resolved, parent] = await Promise.all([
      realpath(allowedRoot),
      realpath(path),
      realpath(dirname(allowedRoot)),
    ]);
    if (root !== join(parent, basename(allowedRoot)))
      throw new Error("Private user root cannot be a symlink");
    const inside = relative(root, resolved);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error("Outside private user storage");
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if ((await realpath(path)) !== resolved)
        throw new Error("Artifact path changed during verification");
      if (!info.isFile() || info.size > 20_000_000) throw new Error("Invalid artifact");
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch {
    throw conflict("Evidence artifact is unavailable or outside private user storage.");
  }
}

export async function verifyPrivateArtifact(path: string, sha256: string, allowedRoot: string) {
  const actual = createHash("sha256")
    .update(await readPrivateArtifact(path, allowedRoot))
    .digest("hex");
  if (actual !== sha256) throw conflict("Evidence artifact SHA256 does not match.");
}

export function trustedRequisition(
  record: {
    identity: string;
    requisitionId: string | null;
    company: string;
    url: string;
    details: unknown;
  },
  canonicalEmployer?: string,
) {
  const source = z
    .object({
      posting: z.object({
        source: z.enum(["greenhouse", "lever", "ashby", "cbs"]),
        sourceRegion: z.enum(["global", "eu"]).nullable().optional(),
        boardToken: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        nativeId: z.string().min(1),
        internalJobId: z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .nullable()
          .optional(),
        requisitionId: z.string().nullable().optional(),
        raw: z.record(z.string(), z.unknown()).optional(),
        employer: z.string().min(1),
        url: z.url(),
      }),
    })
    .safeParse(record.details);
  if (!source.success) throw conflict("A trusted stored employer requisition is required.");
  const posting = source.data.posting;
  const identity = `${personalSourceIdentity({ source: posting.source, boardToken: posting.boardToken, region: posting.sourceRegion ?? undefined })}:${posting.nativeId}`;
  if (
    record.identity !== identity ||
    record.requisitionId !== posting.nativeId ||
    record.company !== posting.employer ||
    new URL(record.url).href !== new URL(posting.url).href
  )
    throw conflict("Record identity does not match its trusted employer requisition.");
  // Older snapshots already retained these public source fields under raw.
  const rawInternal = posting.raw?.internal_job_id;
  const internalJobId =
    posting.internalJobId ??
    (typeof rawInternal === "number" && Number.isSafeInteger(rawInternal) && rawInternal > 0
      ? String(rawInternal)
      : null);
  const rawRequisition = posting.raw?.requisition_id;
  const requisitionId =
    posting.requisitionId?.trim() ||
    (typeof rawRequisition === "string" ? rawRequisition.trim() : "");
  const employerKey =
    canonicalEmployer?.replace(/^name:/, "") ??
    posting.employer.trim().toLowerCase().replace(/\s+/g, " ");
  let sourceIdentity = personalSourceIdentity({
    source: posting.source,
    boardToken: posting.boardToken,
    region: posting.sourceRegion ?? undefined,
  });
  // A CBS import board contains multiple employers, so requisition numbers are not board-global.
  if (posting.source === "cbs") sourceIdentity += `:employer:${encodeURIComponent(employerKey)}`;
  let jobKey = `post:${posting.nativeId}`;
  if (requisitionId) jobKey = `req:${encodeURIComponent(requisitionId)}`;
  if (internalJobId) jobKey = `job:${internalJobId}`;
  const submissionIdentity = `${sourceIdentity}:${jobKey}`;
  return {
    identity,
    requisitionId: posting.nativeId,
    company: posting.employer,
    submissionIdentity,
    employerRequisitionKey: requisitionId
      ? `${encodeURIComponent(employerKey)}:req:${encodeURIComponent(requisitionId)}`
      : null,
  };
}

export function guardLegacyPersonalSubmission() {
  if (process.env.PERSONAL_MODE === "true") {
    throw conflict(
      "Personal mode requires the personal attempt broker; legacy apply claims and result writes cannot authorize a submission.",
    );
  }
}
