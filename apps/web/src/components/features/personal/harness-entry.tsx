/**
 * Browser test harness for the personal dashboard components — NOT part of the app.
 *
 * The /personal route sits behind the server-side auth proxy, which a page-level
 * route mock cannot satisfy, so Playwright bundles this entry instead: the real
 * components, the real providers, and a URL-backed pagination stand-in, with every
 * API call intercepted at the network layer by tests/personal-ui/.
 * All data below is synthetic; no personal records are read.
 */
import { type ReactElement, useEffect, useReducer, useState } from "react";
import type { PersonalRecordDto } from "@jobpilot/contracts/personal";
import { CssBaseline, ThemeProvider as MuiThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { PaginationParams } from "@/hooks/use-pagination";
import { ToastProvider } from "@/providers/notification-provider";
import { theme } from "@/theme";
import { ActivityPanel } from "./activity-panel";
import { CampaignCard } from "./campaign-card";
import { CapabilityBanner } from "./capability-banner";
import { DigestPanel } from "./digest-panel";
import { DiscoverCard } from "./discover-card";
import { ReadinessPanel } from "./readiness-panel";
import { RecordsTable } from "./records-table";
import { RegistryPanel } from "./registry-panel";
import { ResumeIntakeCard } from "./resume-intake-card";
import { SearchPanel } from "./search-panel";
import { SettingsForm } from "./settings-form";
import { SourcesPanel } from "./sources-panel";

const CAPABILITIES = {
  personalMode: true,
  offlinePreview: true,
  liveSubmissions: false,
  missingSetup: ["Resume source not configured"],
};

const SOURCES = [
  {
    id: "src-complete-empty",
    source: "boards.greenhouse.io/emptyco",
    status: "complete",
    count: 0,
    error: null,
    createdAt: new Date("2026-09-15T10:00:00Z"),
  },
  {
    id: "src-failed",
    source: "boards.greenhouse.io/brokenco",
    status: "failed",
    count: 3,
    error: "Board token rejected (404)",
    createdAt: new Date("2026-09-15T09:30:00Z"),
  },
] as const;

const RESUME = {
  id: "res-synthetic",
  label: "synthetic-source.pdf",
  sourceHash: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  conflicts: ["Availability window overlaps graduation year"],
  createdAt: new Date("2026-09-15T08:00:00Z"),
};

const ACTIVITY = [
  {
    id: "att-1",
    recordId: "rec-post-mba-uncertain",
    mode: "submit",
    state: "submission_uncertain",
    updatedAt: new Date("2026-09-15T11:30:00Z"),
  },
  {
    id: "att-2",
    recordId: "rec-general-ineligible",
    mode: "offline",
    state: "prepared",
    updatedAt: new Date("2026-09-15T11:20:00Z"),
  },
];

const SUPERVISOR = {
  status: "running",
  updatedAt: "2026-09-15T11:35:00Z",
  error: null,
};

const RECORDS: PersonalRecordDto[] = [
  {
    id: "rec-mba-intern",
    campaignId: null,
    identity: "synthetic-identity-1",
    title: "MBA Intern — Product",
    company: "Synthetic Labs",
    url: "https://boards.greenhouse.io/syntheticlabs/jobs/1001",
    requisitionId: "1001",
    track: "mba_internship",
    state: "eligible",
    fitScore: 82,
    fitReasons: ["Product rotation matches target function"],
    eligibility: { decision: "eligible", reasons: ["Enrolled MBA, graduates 2027"] },
    missingAnswers: [],
    seniority: {
      classification: "graduate_recruiting",
      reasons: ["MBA enrollment required"],
      evidence: [{ field: "description", quote: "Candidates must be enrolled in an MBA program" }],
    },
    preview: null,
    updatedAt: new Date("2026-09-15T11:00:00Z"),
  },
  {
    id: "rec-post-mba-uncertain",
    campaignId: null,
    identity: "synthetic-identity-2",
    title: "Post-MBA Associate",
    company: "Synthetic Partners",
    url: "https://boards.greenhouse.io/syntheticpartners/jobs/2002",
    requisitionId: "2002",
    track: "post_mba_fulltime",
    state: "submission_uncertain",
    fitScore: null,
    fitReasons: [],
    // Unknown eligibility with no fit score: neither column may imply the other.
    eligibility: { decision: "unknown", reasons: ["Work authorization not answered"] },
    missingAnswers: ["Authorized to work", "Requires sponsorship"],
    preview: null,
    updatedAt: new Date("2026-09-15T11:05:00Z"),
  },
  {
    id: "rec-blocked-ops",
    campaignId: null,
    identity: "synthetic-identity-4",
    title: "Ops Intern",
    company: "Synthetic Logistics",
    url: "https://boards.greenhouse.io/syntheticlogistics/jobs/4004",
    requisitionId: "4004",
    track: "mba_internship",
    state: "blocked",
    fitScore: 64,
    fitReasons: ["Operations rotation matches"],
    eligibility: { decision: "unknown", reasons: ["Enrollment not yet confirmed"] },
    missingAnswers: ["Currently enrolled in an MBA"],
    // Unresolved blocks preparation: no affirmative graduate-level evidence yet.
    seniority: {
      classification: "unresolved",
      reasons: ["Posting does not state degree level"],
      evidence: [],
    },
    preview: null,
    updatedAt: new Date("2026-09-15T11:15:00Z"),
  },
  {
    id: "rec-general-ineligible",
    campaignId: null,
    identity: "synthetic-identity-3",
    title: "Senior Pricing Lead",
    company: "Synthetic Industrials",
    url: "https://boards.greenhouse.io/syntheticindustrials/jobs/3003",
    requisitionId: null,
    track: "general_professional",
    state: "prepared",
    // High fit, hard-ineligible: the two verdicts must stay separate columns.
    fitScore: 91,
    fitReasons: ["Eight years adjacent experience"],
    eligibility: {
      decision: "ineligible",
      reasons: ["Requires US citizenship for export control"],
    },
    seniority: {
      classification: "experienced_professional",
      reasons: ["8+ years required"],
      evidence: [{ field: "description", quote: "Requires 8+ years of pricing experience" }],
    },
    missingAnswers: [],
    preview: {
      mode: "offline",
      pdfUrl: "http://localhost:4101/api/personal/rec-general-ineligible/pdf",
      pdfHash: "sha256-pdfhash1",
      manifestHash: "sha256-manifesthash1",
      readiness: "draft",
      conflicts: [],
      renderReviewed: false,
    },
    updatedAt: new Date("2026-09-15T11:10:00Z"),
  },
  {
    id: "rec-warehouse-entry",
    campaignId: null,
    identity: "synthetic-identity-5",
    title: "Warehouse Associate",
    company: "Synthetic Depot",
    url: "https://boards.greenhouse.io/syntheticdepot/jobs/5005",
    requisitionId: "5005",
    track: "general_professional",
    state: "discovered",
    fitScore: 12,
    fitReasons: [],
    eligibility: { decision: "eligible", reasons: [] },
    missingAnswers: [],
    // Hard-excluded classification: prepare actions must stay unavailable.
    seniority: {
      classification: "undergraduate_entry",
      reasons: ["High-school entry role"],
      evidence: [{ field: "description", quote: "No degree or experience required" }],
    },
    preview: null,
    updatedAt: new Date("2026-09-15T11:20:00Z"),
  },
];

/** URL-backed pagination stand-in: same contract as usePaginationParams, no Next router. */
function useHarnessPagination(): PaginationParams {
  const [params, setParams] = useState({ page: 1, pageSize: 10, track: "" });
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const write = (next: { page: number; pageSize: number; track: string }): void => {
    const search = new URLSearchParams();
    if (next.page > 1) search.set("page", String(next.page));
    if (next.track) search.set("track", next.track);
    const query = search.toString();
    window.history.replaceState(null, "", query ? `/?${query}` : "/");
    setParams(next);
    rerender();
  };

  return {
    page: params.page,
    pageSize: params.pageSize,
    setPage: (page) => write({ ...params, page }),
    setPageSize: (pageSize) => write({ ...params, pageSize, page: 1 }),
    setFilters: (updates) => {
      const track = "track" in updates ? String(updates.track ?? "") : params.track;
      write({ ...params, track, page: 1 });
    },
    query: { page: params.page, limit: params.pageSize },
  };
}

function Harness(): ReactElement {
  const pagination = useHarnessPagination();
  const [records, setRecords] = useState(RECORDS);
  useEffect(() => {
    const update = (event: Event): void => {
      setRecords((event as CustomEvent<PersonalRecordDto[]>).detail);
    };
    window.addEventListener("personal-harness-records", update);
    return () => window.removeEventListener("personal-harness-records", update);
  }, []);
  return (
    <main>
      <section id="capability" data-testid="capability">
        <CapabilityBanner capabilities={CAPABILITIES} />
      </section>
      <section id="readiness" data-testid="readiness">
        <ReadinessPanel />
      </section>
      <section id="sources" data-testid="sources">
        <SourcesPanel sources={[...SOURCES]} />
      </section>
      <section id="resume" data-testid="resume">
        <ResumeIntakeCard resume={RESUME} intakeEnabled />
      </section>
      <section id="records" data-testid="records">
        <RecordsTable
          records={records}
          paginationMeta={{
            page: 1,
            limit: 10,
            total: RECORDS.length,
            totalPages: 1,
          }}
          loading={false}
          offlinePreview
          pagination={pagination}
          track={null}
          onTrackChange={() => {}}
        />
      </section>
      <section id="discover" data-testid="discover">
        <DiscoverCard discoverEnabled />
      </section>
      <section id="search" data-testid="search">
        <SearchPanel />
      </section>
      <section id="registry" data-testid="registry">
        <RegistryPanel />
      </section>
      <section id="digest" data-testid="digest">
        <DigestPanel />
      </section>
      <section id="campaigns" data-testid="campaigns">
        <CampaignCard />
      </section>
      <section id="attempts" data-testid="attempts">
        <ActivityPanel activity={ACTIVITY} supervisor={SUPERVISOR} />
      </section>
      <section id="settings" data-testid="settings">
        <SettingsForm />
      </section>
    </main>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MuiThemeProvider theme={theme}>
          <CssBaseline />
          <Harness />
        </MuiThemeProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
