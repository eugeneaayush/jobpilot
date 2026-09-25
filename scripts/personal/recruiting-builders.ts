import type { PersonalRecruitingManifest } from "../../packages/contracts/src/personal-recruiting";

export function recruitingFixture(): PersonalRecruitingManifest {
  return {
    schemaVersion: 1,
    updatedAt: "2026-09-20T14:00:00Z",
    cycle: "Synthetic MBA internship 2027",
    objective: "Pursue all three firm internship offers",
    officePreferences: ["New York", "Miami", "Houston"],
    evidence: [
      {
        id: "registration-report",
        kind: "user_report",
        locator: "Synthetic conversation",
        observedAt: "2026-09-20T14:00:00Z",
        summary: "Candidate reports registration; attendance is unknown",
      },
    ],
    firms: (["mckinsey", "bain", "bcg"] as const).map((id) => ({
      id,
      name: id,
      applicationStatus: "unknown",
      deadline: { date: null, timeLabel: null, verification: "unverified", evidenceIds: [] },
      events: [
        {
          id: "coffee-chat",
          title: "Synthetic coffee chat",
          startAt: null,
          endAt: null,
          timeLabel: null,
          url: "https://example.com/chat",
          registrationStatus: "registered",
          attendanceStatus: "unknown",
          evidenceIds: ["registration-report"],
          notes: "User report only",
        },
      ],
      actions: [
        {
          id: "confirm",
          title: "Confirm registration",
          dueDate: "2026-09-22",
          status: "open",
          evidenceIds: ["registration-report"],
          notes: "Read confirmation",
        },
      ],
    })),
  };
}
