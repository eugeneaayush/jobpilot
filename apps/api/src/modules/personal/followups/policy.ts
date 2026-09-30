import {
  type PersonalFollowupHistory,
  personalFollowupHistorySchema,
} from "@jobpilot/contracts/personal-followups";
import { z } from "zod/v4";

const QUIET_MS = 10 * 86_400_000;
export interface SubmittedMaterials {
  attemptId: string;
  manifestHash: string;
  documentSha256: string;
  receiptSha256: string;
  packetHash: string;
  title: string;
  company: string;
  submittedAt: Date;
  recipient: string | null;
}
export function followupHistory(value: unknown): PersonalFollowupHistory {
  return personalFollowupHistorySchema.parse(value ?? []);
}

export function followupDrafts(history: PersonalFollowupHistory) {
  return history
    .filter((event) => event.kind === "drafted")
    .map((event) => {
      const observations = history.filter(
        (item) => item.kind !== "drafted" && item.draftId === event.draft.id,
      );
      const last = observations.at(-1);
      return {
        ...event.draft,
        createdAt: new Date(event.draft.createdAt),
        status: last?.kind ?? ("drafted" as const),
        lastEvidenceAt: last && last.kind !== "drafted" ? new Date(last.at) : null,
      };
    });
}

export function followupEligibility(input: {
  history: PersonalFollowupHistory;
  submission: SubmittedMaterials | null;
  recordState: string;
  applicationStatus: string | null;
  lastActivityAt: Date | null;
  now: Date;
}) {
  const drafts = followupDrafts(input.history);
  const blocked = (blocker: string, availableAt: Date | null = null) => ({
    eligible: false,
    blocker,
    availableAt,
  });
  if (!Number.isFinite(input.now.getTime())) return blocked("Clock is unavailable");
  if (input.recordState !== "submitted" || !input.submission)
    return blocked("A confirmed submission and immutable submitted materials are required");
  if (
    input.applicationStatus &&
    ["interviewing", "offer", "rejected", "withdrawn"].includes(input.applicationStatus)
  )
    return blocked("Handle the recorded application outcome before creating another follow-up");
  if (drafts.length >= 2) return blocked("This application has reached its two-draft limit");
  if (drafts.some((draft) => draft.status === "uncertain"))
    return blocked("Reconcile the previous follow-up delivery before drafting again");
  if (drafts.some((draft) => draft.status === "employer_confirmed"))
    return blocked("An employer reply is available; review it before drafting again");
  if (drafts.some((draft) => draft.status === "drafted"))
    return blocked("An unsent draft already exists");
  const activity = [
    input.submission.submittedAt,
    input.lastActivityAt,
    ...drafts.map((draft) => draft.lastEvidenceAt),
  ].filter((value): value is Date => value !== null);
  if (activity.some((value) => !Number.isFinite(value.getTime()) || value > input.now))
    return blocked("Submission or contact timestamps need reconciliation");
  const availableAt = new Date(Math.max(...activity.map((value) => value.getTime())) + QUIET_MS);
  if (availableAt > input.now)
    return blocked("Wait for ten quiet days after the latest application activity", availableAt);
  return { eligible: true, blocker: null, availableAt };
}

export function createFollowupDraft(submission: SubmittedMaterials, ordinal: 1 | 2, now: Date) {
  const title = submission.title
    .replace(/[\r\n\0]+/g, " ")
    .trim()
    .slice(0, 200);
  const company = submission.company
    .replace(/[\r\n\0]+/g, " ")
    .trim()
    .slice(0, 150);
  if (!title || !company) throw new Error("Frozen application identity is incomplete");
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(submission.submittedAt);
  const opening = ordinal === 1 ? "I’m following up" : "I wanted to check in once more";
  const body = `Hello,\n\n${opening} on my application for ${title} at ${company}, submitted on ${date}. I remain interested in the role and would appreciate any update on the recruiting timeline.\n\nThank you for your time and consideration.`;
  return personalFollowupHistorySchema.parse([
    {
      kind: "drafted",
      draft: {
        id: crypto.randomUUID(),
        ordinal,
        subject: `Following up: ${title}`,
        body,
        recipient: submission.recipient,
        createdAt: now.toISOString(),
        attemptId: submission.attemptId,
        manifestHash: submission.manifestHash,
        documentSha256: submission.documentSha256,
        receiptSha256: submission.receiptSha256,
        packetHash: submission.packetHash,
      },
    },
  ])[0];
}

const messageSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  channel: z.literal("email"),
  subject: z.string().nullable(),
  body: z.string(),
  status: z.string(),
  providerId: z.string().nullable(),
  threadId: z.string().nullable(),
  sentAt: z.date().nullable(),
  contact: z.object({
    userId: z.uuid(),
    relatedAppId: z.uuid().nullable(),
    email: z.email().nullable(),
    emailSource: z.string().nullable(),
  }),
});

export function verifyFollowupMessage(
  value: unknown,
  userId: string,
  applicationId: string,
  draft: ReturnType<typeof followupDrafts>[number],
  kind: "sent" | "uncertain" | "employer_confirmed",
  now: Date,
) {
  const message = messageSchema.parse(value);
  if (
    message.userId !== userId ||
    message.contact.userId !== userId ||
    message.contact.relatedAppId !== applicationId ||
    message.body !== draft.body ||
    message.subject !== draft.subject ||
    !draft.recipient ||
    message.contact.email !== draft.recipient ||
    !["verified", "provided"].includes(message.contact.emailSource ?? "")
  )
    throw new Error("Outbound evidence does not match this exact draft and verified contact");
  if (kind === "uncertain") {
    if (message.status !== "failed" || (!message.providerId && !message.sentAt))
      throw new Error("A failed promise or unsent message is not uncertain transmission evidence");
  } else if (
    !["sent", "replied"].includes(message.status) ||
    !message.providerId ||
    !message.sentAt
  ) {
    throw new Error("A provider receipt and send time are required to mark a draft sent");
  }
  if (message.sentAt && (message.sentAt < draft.createdAt || message.sentAt > now))
    throw new Error("Outbound evidence predates the draft or is in the future");
  return message;
}
