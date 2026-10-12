import type { PersonalFollowupHistory } from "@jobpilot/contracts/personal-followups";
import {
  createFollowupDraft,
  followupDrafts,
  followupEligibility,
  followupHistory,
  type SubmittedMaterials,
  verifyFollowupMessage,
} from "./policy";
import { describe, expect, test } from "bun:test";

const userId = "00000000-0000-4000-8000-000000000001";
const applicationId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-09-30T16:00:00Z");
const submission: SubmittedMaterials = {
  attemptId: "00000000-0000-4000-8000-000000000003",
  manifestHash: "a".repeat(64),
  documentSha256: "b".repeat(64),
  receiptSha256: "c".repeat(64),
  packetHash: "d".repeat(64),
  title: "Investment Analyst",
  company: "Example Capital",
  submittedAt: new Date("2026-09-01T16:00:00Z"),
  recipient: "careers@example.com",
};
const context = {
  submission,
  history: [] as PersonalFollowupHistory,
  recordState: "submitted",
  applicationStatus: "applied",
  lastActivityAt: null,
  now,
};

function drafted() {
  return createFollowupDraft(submission, 1, new Date("2026-09-15T16:00:00Z"));
}
function observation(
  draftId: string,
  kind: "sent" | "employer_confirmed" | "uncertain",
  at = "2026-09-15T17:00:00Z",
) {
  return {
    kind,
    draftId,
    at,
    networkingMessageId: "00000000-0000-4000-8000-000000000004",
    emailMessageId: null,
    providerId: "provider-id",
    evidenceHash: "e".repeat(64),
  };
}
function outbound() {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    userId,
    channel: "email",
    subject: "test subject",
    body: "test body",
    status: "sent",
    providerId: "provider-id",
    threadId: "thread-1",
    sentAt: new Date("2026-09-15T17:00:00Z"),
    contact: {
      userId,
      relatedAppId: applicationId,
      email: "careers@example.com",
      emailSource: "verified",
    },
  };
}

describe("private follow-up drafts", () => {
  test("uses confirmed submitted evidence and creates no send authority", () => {
    const event = drafted();
    expect(event.kind).toBe("drafted");
    if (event.kind !== "drafted") throw new Error("Expected draft");
    expect(event.draft.body).toContain("Investment Analyst at Example Capital");
    expect(event.draft.body).toContain("September 1, 2026");
    expect(event.draft.documentSha256).toBe(submission.documentSha256);
    expect(event.draft).not.toHaveProperty("sentAt");
    expect(followupEligibility(context).eligible).toBe(true);
  });
  test("does not guess a contact", () => {
    const event = createFollowupDraft({ ...submission, recipient: null }, 1, now);
    if (event.kind !== "drafted") throw new Error("Expected draft");
    expect(event.draft.recipient).toBeNull();
  });
  test.each([
    "prepared",
    "applying",
    "submission_uncertain",
    "failed",
  ])("requires confirmed outcome for %s", (recordState) => {
    expect(followupEligibility({ ...context, recordState }).eligible).toBe(false);
  });
  test("requires immutable evidence", () => {
    expect(followupEligibility({ ...context, submission: null }).eligible).toBe(false);
  });
  test("ten quiet days includes matched inbox and tracking events", () => {
    const result = followupEligibility({
      ...context,
      lastActivityAt: new Date("2026-09-29T16:00:00Z"),
    });
    expect(result.eligible).toBe(false);
    expect(result.availableAt?.toISOString()).toBe("2026-10-09T16:00:00.000Z");
  });
  test("an unsent draft prevents a duplicate", () => {
    expect(followupEligibility({ ...context, history: [drafted()] }).blocker).toContain("unsent");
  });
  test("permits second draft only after a proven sent draft and quiet interval", () => {
    const first = drafted();
    if (first.kind !== "drafted") throw new Error("Expected draft");
    const history = followupHistory([first, observation(first.draft.id, "sent")]);
    expect(followupEligibility({ ...context, history }).eligible).toBe(true);
    const second = createFollowupDraft(submission, 2, now);
    expect(followupEligibility({ ...context, history: [...history, second] }).blocker).toContain(
      "two-draft",
    );
  });
  test.each(["uncertain", "employer_confirmed"] as const)("holds after %s", (kind) => {
    const first = drafted();
    if (first.kind !== "drafted") throw new Error("Expected draft");
    expect(
      followupEligibility({
        ...context,
        history: followupHistory([first, observation(first.draft.id, kind)]),
      }).eligible,
    ).toBe(false);
  });
  test.each([
    "interviewing",
    "offer",
    "rejected",
    "withdrawn",
  ])("does not auto-close or draft past %s outcome", (applicationStatus) => {
    expect(followupEligibility({ ...context, applicationStatus }).eligible).toBe(false);
  });
  test("future activity holds instead of assuming quiet", () => {
    expect(
      followupEligibility({ ...context, lastActivityAt: new Date("2026-10-01T00:00:00Z") }).blocker,
    ).toContain("reconciliation");
  });
  test("history validates outcome-specific evidence", () => {
    expect(() => followupHistory([{ kind: "sent", draftId: crypto.randomUUID() }])).toThrow();
  });
  test("verified provider evidence must match exact body and owner", () => {
    const draft = followupDrafts([drafted()])[0];
    const message = { ...outbound(), body: draft.body, subject: draft.subject };
    expect(
      verifyFollowupMessage(message, userId, applicationId, draft, "sent", now).providerId,
    ).toBe("provider-id");
    expect(() =>
      verifyFollowupMessage(
        { ...message, body: "I promise to send this" },
        userId,
        applicationId,
        draft,
        "sent",
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyFollowupMessage(
        { ...message, providerId: null },
        userId,
        applicationId,
        draft,
        "sent",
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyFollowupMessage(
        { ...message, userId: applicationId },
        userId,
        applicationId,
        draft,
        "sent",
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyFollowupMessage(
        { ...message, contact: { ...message.contact, emailSource: "guessed" } },
        userId,
        applicationId,
        draft,
        "sent",
        now,
      ),
    ).toThrow();
  });
  test("a failed unsent draft is not evidence of uncertain transmission", () => {
    const draft = followupDrafts([drafted()])[0];
    const message = {
      ...outbound(),
      body: draft.body,
      subject: draft.subject,
      status: "failed",
      providerId: null,
      sentAt: null,
    };
    expect(() =>
      verifyFollowupMessage(message, userId, applicationId, draft, "uncertain", now),
    ).toThrow();
  });
});
