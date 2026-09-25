export const API = "http://localhost:4101";

/** The local terminal host origin used by the handoff flow. */
export const TERMINAL = "http://localhost:4102";

export const NOW = "2026-09-15T12:00:00.000Z";

const H = (char: string): string => char.repeat(64);

export const recoveryResponse = {
  recordId: "rec-blocked-ops",
  updatedAt: NOW,
  context: {
    identity: "synthetic-identity-4",
    postingHash: H("a"),
    settingsHash: H("b"),
    resumeEvidenceId: "e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
    sourceHash: H("c"),
    evidenceHash: H("d"),
    requirementsHash: H("e"),
  },
  source: {
    title: "Ops Intern — Synthetic Logistics",
    descriptionText: "Bachelor's degree or current MBA enrollment required.",
    url: "https://boards.greenhouse.io/syntheticlogistics/jobs/4004",
  },
  requirements: [
    {
      id: H("1"),
      requirement: "Current MBA enrollment",
      evidence: "Posting states: current MBA enrollment required.",
      status: "unknown",
      candidateEvidence: null,
    },
    {
      id: H("2"),
      requirement: "Work authorization in the US",
      evidence: "Applicants must be authorized to work in the United States.",
      status: "unknown",
      candidateEvidence: "Settings list US under work-authorized countries.",
    },
  ],
  eligibility: "unknown",
  latestAttempt: {
    id: "11111111-2222-3333-4444-555555555555",
    state: "blocked",
    submitAt: null,
    reason: "Login challenge could not complete unattended",
  },
  recovery: {
    allowed: true,
    blockers: [],
    failedAttempts: 1,
    retriesRemaining: 2,
    campaignRunId: "99999999-8888-7777-6666-555555555555",
  },
  history: [],
};

export const handoffResponse = {
  handoffId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  attemptId: "11111111-2222-3333-4444-555555555555",
  recordId: "rec-blocked-ops",
  profileKey: "synthetic-profile",
  allowedOrigin: "https://boards.greenhouse.io",
  reason: "login",
  status: "parked",
  leaseOwner: "supervisor-synthetic",
  leaseGeneration: 1,
  // Far future: the fixture must read "live" regardless of when the suite runs; the
  // stale-lease scenario overrides this per test in network.ts knobs.
  leaseExpiresAt: "2027-09-16T13:00:00.000Z",
  taskId: null,
  updatedAt: NOW,
  browserOpen: false,
  events: [{ sequence: 0, at: NOW, type: "parked", message: "Login challenge required" }],
};

const ATTACHMENT_ID = "77777777-6666-5555-4444-333333333333";

const coverLetterDoc = (reviewed: boolean) => ({
  id: ATTACHMENT_ID,
  fieldName: "cover_letter",
  label: "Cover letter",
  required: true,
  kind: "cover_letter",
  identity: "synthetic-identity-3",
  postingContentHash: H("f"),
  sha256: H("7"),
  bytes: 42_000,
  createdAt: NOW,
  source: {
    resumeEvidenceId: "e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
    sourceHash: H("c"),
    resumeDataHash: H("8"),
    citations: [{ pointer: "/experience/0/highlights/1", value: "Led a two-person pricing study" }],
  },
  pdfUrl: "/api/personal/attachments/rec-general-ineligible/pdf",
  review: reviewed
    ? {
        pdfHash: H("7"),
        inspected: true,
        notes: "Name, date, and citations render correctly.",
        reviewedAt: NOW,
        reviewer: "99999999-9999-9999-9999-999999999999",
      }
    : null,
});

export const attachmentsResponse = {
  recordId: "rec-general-ineligible",
  updatedAt: NOW,
  requirements: [
    { fieldName: "cover_letter", label: "Cover letter", required: true, kind: "cover_letter" },
    { fieldName: "transcript", label: "Unofficial transcript", required: false, kind: "other" },
  ],
  requirementsSource: {
    kind: "greenhouse_questions",
    sha256: H("9"),
    capturedAt: NOW,
    url: "https://boards.greenhouse.io/syntheticindustrials/questions",
  },
  documents: [],
  missingRequired: ["cover_letter"],
  readiness: "draft",
  requiresPreview: true,
};

/** Variant with the cover letter drafted (unreviewed) — after the build POST. */
export const attachmentsWithDraft = {
  ...attachmentsResponse,
  documents: [coverLetterDoc(false)],
  missingRequired: [],
};

/** Variant with the drafted cover letter visually reviewed — readiness unblocked. */
export const attachmentsReviewed = {
  ...attachmentsWithDraft,
  documents: [coverLetterDoc(true)],
  readiness: "ready",
  requiresPreview: true,
};

/** Never-inspected variant: unknown requirements are distinct from none. */
export const attachmentsUnknown = {
  ...attachmentsResponse,
  requirements: [],
  requirementsSource: null,
  missingRequired: [],
  readiness: "unknown",
};

export const challengeResponse = {
  attemptId: "11111111-2222-3333-4444-555555555555",
  transport: null,
  challenge: {
    challengeId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    code: "invalid-security-code",
    status: "awaiting_user",
    hasRecipient: true,
    leaseOwner: null,
    leaseGeneration: 0,
    leaseExpiresAt: null,
    createdAt: NOW,
    expiresAt: "2027-09-16T13:00:00.000Z",
    evidenceHash: H("a"),
    permit: null,
  },
};

const searchCandidate = (page: number, url: string, title: string, snippet: string | null) => ({
  kind: "career_url_candidate" as const,
  url,
  urlHash: H(`${page}${url}`),
  title,
  snippet,
  evidence: "search_snippet" as const,
  fullDescriptionAvailable: false as const,
  employerIdentityVerified: false as const,
  page,
  responseHash: H(`resp${page}`),
});

export const searchPartialResponse = {
  provider: "brave",
  status: "partial",
  queryHash: H("q"),
  candidates: [
    searchCandidate(
      0,
      "https://example.com/careers/ops-analyst",
      "Operations Analyst — Example Corp",
      "…example careers page mentioning an operations analyst role…",
    ),
    searchCandidate(
      1,
      "https://example.org/jobs/senior-pricing",
      "Senior Pricing Manager — Example Org",
      null,
    ),
  ],
  coverage: {
    scope: "search_query",
    exhausted: false,
    empty: false,
    pagesRequested: 3,
    observedCount: 2,
    invalidCount: 1,
    duplicateCount: 0,
    moreResultsAvailable: true,
  },
  receipts: [
    {
      reservationId: "cccccccc-0000-0000-0000-000000000001",
      status: "reserved",
      amountMicrousd: 150,
      page: 0,
      sourceUrlHash: H("s0"),
      responseHash: H("resp0"),
      httpStatus: 200,
      observedCount: 1,
      nextEligibleAt: null,
      reason: null,
    },
    {
      reservationId: "cccccccc-0000-0000-0000-000000000002",
      status: "failed",
      amountMicrousd: 150,
      page: 2,
      sourceUrlHash: H("s2"),
      responseHash: null,
      httpStatus: 503,
      observedCount: 0,
      nextEligibleAt: null,
      reason: "Provider refused page 2",
    },
  ],
  budget: {
    month: "2026-09",
    timezone: "America/New_York",
    monthlyLimitMicrousd: 200_000_000,
    searchLimitMicrousd: 5_000_000,
    monthlyReservedMicrousd: 300,
    searchReservedMicrousd: 300,
    tracking: "local_reservations",
    actualProviderBillKnown: false,
  },
  nextEligibleAt: null,
  reasons: ["Provider refused page 2"],
  price: {
    requestMicrousd: 150,
    verifiedOn: "2026-09-16",
    sourceUrl: "https://brave.com/search/api/",
    creditsAssumed: false,
  },
};

export const searchMissingSetupResponse = {
  ...searchPartialResponse,
  status: "missing_setup",
  candidates: [],
  coverage: {
    ...searchPartialResponse.coverage,
    pagesRequested: 0,
    observedCount: 0,
    invalidCount: 0,
    moreResultsAvailable: null,
  },
  receipts: [],
  budget: null,
  reasons: ["Search provider credentials are not configured"],
};

export const registryResponse = {
  sources: [
    {
      id: "11111111-aaaa-4bbb-8ccc-000000000001",
      identity: "greenhouse:syntheticlabs",
      configuration: { source: "greenhouse", boardToken: "syntheticlabs" },
      configurationState: "valid",
      attemptedAt: NOW,
      lastSuccessfulAt: NOW,
      nextEligibleAt: null,
      updatedAt: NOW,
      status: "complete",
      coverage: {},
      adapter: {
        discovery: "public_api",
        submission: "guarded_greenhouse",
        readiness: "not_evaluated",
        submissionEnabledByRegistration: false,
      },
    },
    {
      id: "11111111-aaaa-4bbb-8ccc-000000000002",
      identity: "lever:syntheticorg",
      configuration: { source: "lever", boardToken: "syntheticorg", region: "eu" },
      configurationState: "valid",
      attemptedAt: NOW,
      lastSuccessfulAt: null,
      nextEligibleAt: null,
      updatedAt: NOW,
      status: null,
      coverage: {},
      adapter: {
        discovery: "public_api",
        submission: "restricted_lever",
        readiness: "not_evaluated",
        submissionEnabledByRegistration: false,
      },
    },
  ],
  pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
};

export const aliasesResponse = {
  aliases: [
    {
      id: "44444444-4444-4444-8444-444444444441",
      sourceIdentity: "lever:syntheticorg",
      canonicalEmployer: "synthetic.org",
      verification: "owner_attested",
      evidenceHash: H("alias1"),
      evidence: {},
      createdAt: NOW,
      replacementRule: "blocked_after_any_attempt_or_reservation",
    },
    {
      id: "44444444-4444-4444-8444-444444444442",
      sourceIdentity: "greenhouse:legacyco",
      canonicalEmployer: "legacy.example",
      verification: "legacy_unverified",
      evidenceHash: H("alias2"),
      evidence: {},
      createdAt: NOW,
      replacementRule: "blocked_after_any_attempt_or_reservation",
    },
  ],
  pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
};

export const policyResponse = {
  dailyCap: 50,
  employerActiveCap: 3,
  monthlyBudgetCents: 20000,
  searchBudgetCents: 5000,
  timezone: "America/New_York",
  version: "v1",
  updatedAt: NOW,
  ceilings: {
    dailyCap: 50,
    employerActiveCap: 3,
    monthlyBudgetCents: 20000,
    searchBudgetCents: 5000,
    timezone: "America/New_York",
  },
  adjustment: "downward_only",
};

export const digestResponse = {
  digest: {
    schemaVersion: 1,
    sha256: H("digest"),
    userId: "22222222-2222-4222-8222-222222222222",
    day: "2026-09-15",
    timezone: "America/New_York",
    scheduledHour: 7,
    capturedAt: NOW,
    windowStartAt: "2026-09-14T07:00:00.000Z",
    windowStartExclusive: false,
    delivery: "local_only",
    counters: {
      newDiscoveries: 4,
      prepared: 2,
      submitted: 1,
      uncertain: 1,
      blocked: 1,
      failed: 0,
    },
    counterBasis:
      "New discoveries were created within the reporting window; remaining counters are current record-state totals, not daily transitions.",
    sourceCoverage: {
      sources: [
        {
          identity: "greenhouse:syntheticlabs",
          configured: true,
          health: "complete",
          attemptedAt: NOW,
          completedAt: NOW,
          nextEligibleAt: null,
          observedCount: 4,
          expectedTotal: 4,
          scope: "public_board",
        },
        {
          identity: "cbs:paste-2026-09",
          configured: true,
          health: "stale",
          attemptedAt: "2026-09-10T07:00:00.000Z",
          completedAt: "2026-09-10T07:00:00.000Z",
          nextEligibleAt: null,
          observedCount: 2,
          expectedTotal: null,
          scope: "provided_export",
        },
      ],
      truncated: false,
      wholeMarketCoverage: false,
      note: "Registered sources only.",
    },
    stoppedCampaigns: [],
    campaignsTruncated: false,
    blockers: [
      {
        recordId: "33333333-3333-4333-8333-333333333333",
        title: "Ops Intern",
        company: "Synthetic Logistics",
        kinds: ["answers_required", "security_handoff"],
      },
    ],
    blockersTruncated: false,
  },
};

export const settingsAllNull = {
  mbaEnrolled: null,
  graduationYear: null,
  availableFrom: null,
  availableUntil: null,
  locations: [],
  targetFunctions: [],
  exclusions: [],
  minimumCompensation: null,
  compensationCurrency: null,
  compensationPeriod: null,
  workAuthorization: null,
  workAuthorizationCountries: [],
  availabilityNotes: null,
  requiresSponsorship: null,
  citizenship: null,
  yearsExperience: null,
  fitThreshold: 70,
  dailyCap: 0,
  maxApplications: 0,
  timezone: "America/New_York",
};

/** A loaded profile with the UI-008 fields set, for show/reload coverage. */
export const settingsPopulated = {
  ...settingsAllNull,
  graduationYear: 2027,
  workAuthorizationCountries: ["US", "DE"],
  availabilityNotes:
    "Flexible on start timing around the summer window; open to discussing duration.",
};

export const createInputDefaults = {
  name: "Synthetic run",
  mode: "offline",
  sources: { boardTokens: ["synthboards1"] },
  tracks: ["mba_internship", "post_mba_fulltime", "general_professional"],
  // Compatibility value only: ranking is descending continuous score, never a cutoff.
  fitThreshold: 0,
  dailyCap: 5,
  maxApplications: 50,
  timezone: "America/New_York",
};

export const campaignStopped = (id: string) => ({
  ...createInputDefaults,
  id,
  status: "stopped",
  policyVersion: "pv-1",
  createdAt: NOW,
  updatedAt: NOW,
  authorization: null,
});

export const campaignActive = (id: string) => ({
  ...campaignStopped(id),
  status: "active",
  authorization: {
    runId: "5f0b1c2e-1111-4222-8333-444455556666",
    authorizedAt: NOW,
    settingsHash: "sha256-settingshash00000000000000000000000000000000000000000000",
    resumeEvidenceId: "e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
    sourceHash: "sha256-sourcehash00000000000000000000000000000000000000000000",
    snapshotHash: "sha256-snapshothash0000000000000000000000000000000000000000",
  },
});

export const emptyPage = <T>(items: T[]) => ({
  items,
  pagination: { page: 1, limit: 10, total: items.length, totalPages: 1 },
});

export const readinessFixture = {
  checkedAt: NOW,
  personalMode: true,
  providerApproval: { approved: true, scope: "metadata_only" },
  resume: {
    status: "conflicted",
    evidenceId: "e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
    sourceHash: "f".repeat(64),
    conflicts: ["Availability window overlaps graduation year"],
  },
  terminal: {
    status: "available",
    checkedAt: NOW,
    structuredTasks: true,
    mock: false,
    brokerConfigured: true,
    codexSupervisorEnabled: true,
    providerApproved: true,
    providerApprovalScope: "metadata_only",
    providerApprovalBlockReason: null,
    providers: [
      { id: "codex", installed: true, version: "1.0.0" },
      { id: "claude", installed: false, version: null },
    ],
    blockReason: null,
  },
  browser: {
    status: "needs_per_job",
    reason: "Each posting's form is visited with your explicit answers only.",
  },
  missingSettings: [
    { field: "fitThreshold", scope: "campaign", reason: "Not set in settings." },
    { field: "workAuthorization", scope: "per_job", reason: "Asked on the posting form." },
    { field: "requiresSponsorship", scope: "per_job", reason: "Asked on the posting form." },
  ],
  blockers: ["Provider approval pending for applicant data"],
  campaignExecutionReady: false,
};

export const answersFixture = {
  recordId: "rec-mba-intern",
  updatedAt: NOW,
  snapshot: {
    schemaVersion: 1,
    recordId: "rec-mba-intern",
    identity: "synthetic-identity-1",
    postingContentHash: "1".repeat(64),
    settingsHash: "2".repeat(64),
    createdAt: NOW,
    snapshotHash: "3".repeat(64),
    answers: [
      {
        key: "requires-sponsorship",
        value: "No",
        label: "Requires sponsorship",
        fieldName: "sponsorship_code",
        source: { kind: "explicit_user", confirmed: true },
      },
    ],
  },
  requiresPreview: true,
  questions: [
    { fieldName: "authorization", label: "Authorized to work", type: "text", required: true },
    { fieldName: "confirmed", label: "Synthetic confirmation", type: "checkbox", required: true },
  ],
};

export const PDF_HASH = "a".repeat(64);

export const previewRecord = {
  id: "rec-mba-intern",
  campaignId: null,
  identity: "synthetic-identity-1",
  title: "MBA Intern — Product",
  company: "Synthetic Labs",
  url: "https://boards.greenhouse.io/syntheticlabs/jobs/1001",
  requisitionId: "1001",
  track: "mba_internship",
  state: "prepared",
  fitScore: 82,
  fitReasons: ["Product rotation matches target function"],
  eligibility: { decision: "eligible", reasons: ["Enrolled MBA, graduates 2027"] },
  missingAnswers: [],
  preview: {
    mode: "offline",
    // The API issues relative URLs; the components must pin them to the API origin.
    pdfUrl: "/api/personal/rec-mba-intern/pdf",
    pdfHash: PDF_HASH,
    manifestHash: `b${"c".repeat(63)}`,
    readiness: "draft",
    conflicts: [],
    renderReviewed: false,
  },
  updatedAt: NOW,
};
