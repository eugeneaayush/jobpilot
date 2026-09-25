import { z } from "zod";

const text = z.string().min(1).max(4000);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/);
const day = z.iso.date().refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date");
const timestamp = z.iso.datetime({ offset: true }).refine((value) => {
  return day.safeParse(value.slice(0, 10)).success && Number.isFinite(Date.parse(value));
}, "Expected a real ISO timestamp with timezone");
const evidenceIds = z.array(id).max(100);
const evidence = z.strictObject({
  id,
  kind: z.enum(["email", "official_page", "user_report", "local_record"]),
  locator: text,
  observedAt: timestamp,
  summary: text,
});
const safeUrl = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Only HTTP(S) URLs without credentials are allowed");
const firm = z.strictObject({
  id: z.enum(["mckinsey", "bain", "bcg"]),
  name: z.string().min(1).max(100),
  applicationStatus: z.enum([
    "unknown",
    "not_submitted",
    "submitted",
    "interviewing",
    "offer",
    "rejected",
  ]),
  deadline: z.strictObject({
    date: day.nullable(),
    timeLabel: text.nullable(),
    verification: z.enum(["verified", "unverified"]),
    evidenceIds,
  }),
  events: z
    .array(
      z.strictObject({
        id,
        title: text,
        startAt: timestamp.nullable(),
        endAt: timestamp.nullable(),
        timeLabel: text.nullable(),
        url: safeUrl.nullable(),
        registrationStatus: z.enum([
          "unknown",
          "interest_submitted",
          "invited_to_schedule",
          "registered",
          "full",
          "waitlisted",
          "cancelled",
        ]),
        attendanceStatus: z.enum(["unknown", "attended", "missed"]),
        evidenceIds,
        notes: z.string().max(6000),
      }),
    )
    .max(100),
  actions: z
    .array(
      z.strictObject({
        id,
        title: text,
        dueDate: day.nullable(),
        status: z.enum(["open", "done", "blocked"]),
        evidenceIds,
        notes: z.string().max(6000),
      }),
    )
    .max(100),
});

// File timestamps remain strings; HTTP consumers convert dates at their response boundary.
export const personalRecruitingManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    updatedAt: timestamp,
    cycle: z.string().min(1).max(200),
    objective: text,
    officePreferences: z.array(z.string().min(1).max(100)).min(1).max(10),
    evidence: z.array(evidence).max(500),
    firms: z.array(firm).length(3),
  })
  .superRefine((manifest, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) issue(`Duplicate ${label}`);
    };
    unique(manifest.officePreferences, "office preferences");
    unique(
      manifest.evidence.map((item) => item.id),
      "evidence id",
    );
    unique(
      manifest.firms.map((item) => item.id),
      "firm id; exactly all three MBB firms are required",
    );
    const knownEvidence = new Set(manifest.evidence.map((item) => item.id));
    const checkReferences = (references: string[]) => {
      unique(references, "evidence reference");
      for (const reference of references) {
        if (!knownEvidence.has(reference)) issue(`Unknown evidence reference: ${reference}`);
      }
    };
    for (const item of manifest.firms) {
      checkReferences(item.deadline.evidenceIds);
      if (
        item.deadline.verification === "verified" &&
        (!item.deadline.date || item.deadline.evidenceIds.length === 0)
      ) {
        issue("Verified deadlines require a date and evidence");
      }
      unique(
        item.events.map((event) => event.id),
        "event id within firm",
      );
      unique(
        item.actions.map((action) => action.id),
        "action id within firm",
      );
      for (const event of item.events) {
        checkReferences(event.evidenceIds);
        if (event.startAt && event.endAt && Date.parse(event.endAt) < Date.parse(event.startAt)) {
          issue("Event end precedes start");
        }
      }
      for (const action of item.actions) checkReferences(action.evidenceIds);
    }
  });

export const personalRecruitingSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capturedAt: timestamp,
  source: z.strictObject({
    root: text,
    relativePath: z.literal("data/mbb/recruiting-operations.json"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    gitHead: z.string().regex(/^[a-f0-9]{40,64}$/),
    gitDirty: z.boolean(),
  }),
  manifest: personalRecruitingManifestSchema,
});

export type PersonalRecruitingManifest = z.infer<typeof personalRecruitingManifestSchema>;
export type PersonalRecruitingSnapshot = z.infer<typeof personalRecruitingSnapshotSchema>;
