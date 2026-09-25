import type { PersonalRecruitingSnapshot } from "@jobpilot/contracts/personal-recruiting";

export function recruitingSnapshotFixture(): PersonalRecruitingSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-20T14:00:00Z",
    source: {
      root: "/synthetic/private-source",
      relativePath: "data/mbb/recruiting-operations.json",
      sha256: "a".repeat(64),
      gitHead: "b".repeat(40),
      gitDirty: true,
    },
    manifest: {
      schemaVersion: 1,
      updatedAt: "2026-09-20T13:00:00Z",
      cycle: "Synthetic MBA internship cycle",
      objective: "Synthetic three-firm recruiting plan",
      officePreferences: ["New York", "Miami", "Houston"],
      evidence: [
        {
          id: "source-email",
          kind: "email",
          locator: "private-email-identifier",
          observedAt: "2026-09-20T12:00:00Z",
          summary: "Synthetic registration receipt",
        },
        {
          id: "source-official",
          kind: "official_page",
          locator: "https://example.test/recruiting",
          observedAt: "2026-09-20T12:00:00Z",
          summary: "Synthetic public information",
        },
      ],
      firms: (["mckinsey", "bain", "bcg"] as const).map((id) => ({
        id,
        name: id,
        applicationStatus: "unknown",
        deadline: {
          date: "2026-11-01",
          timeLabel: null,
          verification: "unverified",
          evidenceIds: ["source-official"],
        },
        events: [
          {
            id: `${id}-chat`,
            title: "Synthetic coffee chat",
            startAt: "2026-10-01T10:00:00-04:00",
            endAt: "2026-10-01T10:20:00-04:00",
            timeLabel: null,
            url: "https://example.test/chat",
            registrationStatus: "registered",
            attendanceStatus: "unknown",
            evidenceIds: ["source-email"],
            notes: "Synthetic evidence does not prove attendance.",
          },
        ],
        actions: [
          {
            id: `${id}-confirm`,
            title: "Confirm deadline",
            dueDate: "2026-09-21",
            status: "open",
            evidenceIds: [],
            notes: "Synthetic target date",
          },
        ],
      })),
    },
  };
}
