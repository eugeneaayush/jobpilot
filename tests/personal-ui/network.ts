import { expect, type Page } from "@playwright/test";
import {
  API,
  aliasesResponse,
  answersFixture,
  attachmentsResponse,
  attachmentsReviewed,
  attachmentsWithDraft,
  campaignActive,
  campaignStopped,
  challengeResponse,
  digestResponse,
  emptyPage,
  handoffResponse,
  policyResponse,
  previewRecord,
  readinessFixture,
  recoveryResponse,
  registryResponse,
  searchPartialResponse,
  settingsAllNull,
  TERMINAL,
} from "./fakes";

/** Everything each test observed: captured bodies plus the full request log. */
interface Observed {
  requests: string[];
  settingsPut: unknown;
  campaignCreate: unknown;
  campaignLaunch: { url: string; body: unknown } | null;
  campaignStop: { url: string; body: unknown } | null;
  previewPosts: string[];
  renderReviews: { url: string; body: unknown }[];
  formPreviewGets: string[];
  answersPosts: { url: string; body: unknown }[];
  /** Tests flip this to 409 to exercise stale-draft invalidation. */
  answersPostStatus: number;
  answersResponse: typeof answersFixture;
  /** GET /settings response; tests swap in a populated profile. */
  settingsResponse: Record<string, unknown>;
  /** GET recovery response; tests swap in per-record variants. */
  recoveryResponse: Record<string, unknown>;
  /** GET handoff response; terminal actions advance its status. */
  handoffResponse: Record<string, unknown>;
  recoveryEligibilityPosts: { url: string; body: unknown }[];
  recoveryPosts: { url: string; body: unknown }[];
  /** GET attachments response; the build/review POSTs advance it stepwise. */
  attachmentsResponse: Record<string, unknown>;
  attachmentRefreshes: string[];
  coverLetterPosts: { url: string; body: unknown }[];
  attachmentReviews: { url: string; body: unknown }[];
  /** Authoritative terminal-host view: live browser state the API omits. */
  terminalHandoff: { status: string; browserOpen: boolean; leaseGeneration?: number };
  /** Resume normally leaves the challenge pending; tests flip this to resolve it. */
  resolveOnResume: boolean;
  /** Open normally confirms the browser; tests flip this to exercise the unconfirmed DTO. */
  openConfirmsBrowser: boolean;
  handoffActions: { action: string; url: string; authorized: boolean }[];
  /** Unauthenticated terminal calls rejected by the WorkerBearerFilter stand-in. */
  unauthorizedTerminalCalls: string[];
  /** Tokens issued by the auth endpoint, in order — proves re-acquisition after a 401. */
  terminalTokenRequests: string[];
  /** First-issued token is stale (rejected by the terminal) to exercise 401 invalidation. */
  expireFirstToken: boolean;
  /** GET challenge response; tests swap in per-attempt variants. */
  challengeResponse: Record<string, unknown>;
  challengeVerifies: { authorized: boolean; body: unknown }[];
  /** POST search response; tests swap in per-query variants. */
  searchResponse: Record<string, unknown>;
  searchPosts: { body: unknown }[];
  /** GET registry/policy/digest responses; tests swap in variants. */
  registryResponse: Record<string, unknown>;
  aliasesResponse: Record<string, unknown>;
  policyResponse: Record<string, unknown>;
  digestResponse: Record<string, unknown>;
}

const observedByPage = new WeakMap<Page, Observed>();

export function observe(page: Page): Observed {
  const observed: Observed = {
    requests: [],
    settingsPut: undefined,
    campaignCreate: undefined,
    campaignLaunch: null,
    campaignStop: null,
    previewPosts: [],
    renderReviews: [],
    formPreviewGets: [],
    answersPosts: [],
    answersPostStatus: 200,
    answersResponse: structuredClone(answersFixture),
    settingsResponse: structuredClone(settingsAllNull),
    recoveryResponse: structuredClone(recoveryResponse),
    handoffResponse: structuredClone(handoffResponse),
    recoveryEligibilityPosts: [],
    recoveryPosts: [],
    attachmentsResponse: structuredClone(attachmentsResponse),
    attachmentRefreshes: [],
    coverLetterPosts: [],
    attachmentReviews: [],
    terminalHandoff: { status: "parked", browserOpen: false, leaseGeneration: 1 },
    resolveOnResume: false,
    openConfirmsBrowser: true,
    handoffActions: [],
    unauthorizedTerminalCalls: [],
    terminalTokenRequests: [],
    expireFirstToken: false,
    challengeResponse: structuredClone(challengeResponse),
    challengeVerifies: [],
    searchResponse: structuredClone(searchPartialResponse),
    searchPosts: [],
    registryResponse: structuredClone(registryResponse),
    aliasesResponse: structuredClone(aliasesResponse),
    policyResponse: structuredClone(policyResponse),
    digestResponse: structuredClone(digestResponse),
  };
  // A fresh capture regardless of wall clock: the stale-warning test overrides this explicitly.
  observed.digestResponse.digest.capturedAt = new Date().toISOString();

  // The campaign list is stateful so a create/launch/stop is visible on the next refetch,
  // exactly like the real API an invalidation re-reads.
  const campaigns: (ReturnType<typeof campaignActive> | ReturnType<typeof campaignStopped>)[] = [];
  // Echoed into every later campaign response, like a real API persisting the created config.
  let savedRoleScope: Record<string, unknown> | undefined;

  // Context-level (not page-level) so PDF/form-preview popups are mocked too.
  const context = page.context();
  context.on("request", (request) => {
    observed.requests.push(request.url());
  });

  // Terminal-host handoff transport: Bearer-gated like the real WorkerBearerFilter, with the
  // authoritative live browser state the API intentionally omits.
  void context.route(`${TERMINAL}/workers/handoffs/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const authorized = request.headers().authorization === "Bearer synthetic-terminal-token";
    if (!authorized) {
      observed.unauthorizedTerminalCalls.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 401, json: { message: "Missing bearer token" } });
      return;
    }
    const action = path.endsWith("/open")
      ? "open"
      : path.endsWith("/resume")
        ? "resume"
        : path.endsWith("/cancel")
          ? "cancel"
          : "unknown";
    if (request.method() === "POST" && action !== "unknown") {
      // No lease body: the host refreshes the authoritative lease itself.
      observed.handoffActions.push({ action, url: path, authorized });
      if (action === "open") {
        // The host renews the lease on open: exactly one generation increment, echoed to the
        // API view so the happy path never shows a synthetic mismatch.
        const generation = (observed.terminalHandoff.leaseGeneration ?? 1) + 1;
        observed.terminalHandoff = {
          status: "open",
          browserOpen: observed.openConfirmsBrowser,
          leaseGeneration: generation,
        };
        observed.handoffResponse = {
          ...observed.handoffResponse,
          status: "open",
          leaseGeneration: generation,
        };
      } else if (action === "resume") {
        if (observed.resolveOnResume) {
          observed.terminalHandoff = { status: "resolved", browserOpen: false };
          observed.handoffResponse = { ...observed.handoffResponse, status: "resolved" };
        } else {
          // Unresolved resume: the challenge remains pending, browser still up.
          observed.terminalHandoff = { status: "open", browserOpen: true };
        }
      } else {
        observed.terminalHandoff = { status: "cancelled", browserOpen: false };
        observed.handoffResponse = { ...observed.handoffResponse, status: "cancelled" };
      }
      await route.fulfill({ status: 200, json: observed.terminalHandoff });
      return;
    }
    await route.fulfill({ status: 200, json: observed.terminalHandoff });
  });

  // The web acquires the terminal PAT exactly like the terminal panel does. The first token
  // can be issued stale so a 401 exercises cache invalidation and re-acquisition.
  void context.route(`${API}/api/auth/tokens/terminal`, async (route) => {
    const stale = observed.expireFirstToken && observed.terminalTokenRequests.length === 0;
    const token = stale ? "expired-terminal-token" : "synthetic-terminal-token";
    observed.terminalTokenRequests.push(token);
    await route.fulfill({ status: 200, json: { token } });
  });

  void context.route(`${API}/api/personal**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" || method === "HEAD" ? undefined : request.postDataJSON();

    if (method === "GET" && path === "/api/personal/readiness") {
      await route.fulfill({ status: 200, json: readinessFixture });
      return;
    }
    if (method === "GET" && /\/api\/personal\/recovery\/records\/[^/]+$/.test(path)) {
      await route.fulfill({ status: 200, json: observed.recoveryResponse });
      return;
    }
    if (method === "POST" && /\/api\/personal\/recovery\/records\/[^/]+\/eligibility$/.test(path)) {
      observed.recoveryEligibilityPosts.push({ url: path, body });
      await route.fulfill({ status: 200, json: observed.recoveryResponse });
      return;
    }
    if (method === "POST" && /\/api\/personal\/recovery\/records\/[^/]+\/recover$/.test(path)) {
      observed.recoveryPosts.push({ url: path, body });
      await route.fulfill({ status: 200, json: observed.recoveryResponse });
      return;
    }
    if (method === "GET" && /\/api\/personal\/attempts\/[^/]+\/handoff$/.test(path)) {
      await route.fulfill({ status: 200, json: observed.handoffResponse });
      return;
    }
    if (method === "GET" && /\/api\/personal\/attempts\/[^/]+\/challenge$/.test(path)) {
      await route.fulfill({ status: 200, json: observed.challengeResponse });
      return;
    }
    if (method === "POST" && /\/api\/personal\/attempts\/[^/]+\/challenge\/verify$/.test(path)) {
      // Private bearer-gated like the real verification route; credentials never logged.
      const authorized = request.headers().authorization === "Bearer synthetic-terminal-token";
      observed.challengeVerifies.push({ authorized, body });
      if (!authorized) {
        await route.fulfill({ status: 403, json: { message: "Private bearer required" } });
        return;
      }
      await route.fulfill({
        status: 200,
        json: { status: "submitted", receiptHash: "e".repeat(64) },
      });
      return;
    }
    if (method === "GET" && /\/api\/personal\/attachments\/[^/]+$/.test(path)) {
      await route.fulfill({ status: 200, json: observed.attachmentsResponse });
      return;
    }
    if (
      method === "POST" &&
      /\/api\/personal\/attachments\/[^/]+\/requirements\/refresh$/.test(path)
    ) {
      observed.attachmentRefreshes.push(path);
      if (observed.attachmentsResponse.requirementsSource === null) {
        observed.attachmentsResponse = structuredClone(attachmentsResponse);
      }
      await route.fulfill({ status: 200, json: observed.attachmentsResponse });
      return;
    }
    if (method === "POST" && /\/api\/personal\/attachments\/[^/]+\/cover-letter$/.test(path)) {
      observed.coverLetterPosts.push({ url: path, body });
      observed.attachmentsResponse = structuredClone(attachmentsWithDraft);
      await route.fulfill({ status: 200, json: observed.attachmentsResponse });
      return;
    }
    if (method === "POST" && /\/api\/personal\/attachments\/[^/]+\/review$/.test(path)) {
      observed.attachmentReviews.push({ url: path, body });
      observed.attachmentsResponse = structuredClone(attachmentsReviewed);
      await route.fulfill({ status: 200, json: observed.attachmentsResponse });
      return;
    }
    if (method === "GET" && /\/api\/personal\/attachments\/[^/]+\/pdf$/.test(path)) {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4 synthetic attachment",
      });
      return;
    }
    if (method === "GET" && /\/api\/personal\/readiness\/records\/[^/]+\/answers$/.test(path)) {
      await route.fulfill({ status: 200, json: observed.answersResponse });
      return;
    }
    if (method === "POST" && /\/api\/personal\/readiness\/records\/[^/]+\/answers$/.test(path)) {
      observed.answersPosts.push({ url: path, body });
      if (observed.answersPostStatus === 409) {
        await route.fulfill({
          status: 409,
          json: { message: "Snapshot changed: expectedUpdatedAt mismatch" },
        });
        return;
      }
      await route.fulfill({ status: 200, json: answersFixture });
      return;
    }
    if (method === "POST" && path === "/api/personal/search") {
      observed.searchPosts.push({ body });
      await route.fulfill({ status: 200, json: observed.searchResponse });
      return;
    }
    if (method === "GET" && path === "/api/personal/registry") {
      await route.fulfill({ status: 200, json: observed.registryResponse });
      return;
    }
    if (method === "GET" && path === "/api/personal/aliases") {
      await route.fulfill({ status: 200, json: observed.aliasesResponse });
      return;
    }
    if (method === "GET" && path === "/api/personal/policy") {
      await route.fulfill({ status: 200, json: observed.policyResponse });
      return;
    }
    if (method === "GET" && path === "/api/personal/digest/latest") {
      await route.fulfill({ status: 200, json: observed.digestResponse });
      return;
    }
    if (method === "GET" && path === "/api/personal/settings") {
      await route.fulfill({ status: 200, json: observed.settingsResponse });
      return;
    }
    if (method === "PUT" && path === "/api/personal/settings") {
      observed.settingsPut = body;
      await route.fulfill({ status: 200, json: settingsAllNull });
      return;
    }
    if (method === "GET" && path === "/api/personal/campaigns") {
      await route.fulfill({ status: 200, json: emptyPage(campaigns) });
      return;
    }
    if (method === "POST" && path === "/api/personal/campaigns") {
      observed.campaignCreate = body;
      savedRoleScope = (body as { roleScope?: Record<string, unknown> }).roleScope;
      const created = {
        ...campaignStopped("cmp-synthetic-1"),
        name: (body as { name?: string }).name ?? "Synthetic run",
        ...(savedRoleScope && { roleScope: savedRoleScope }),
      };
      campaigns.push(created);
      await route.fulfill({ status: 200, json: created });
      return;
    }
    if (method === "POST" && path.endsWith("/launch")) {
      observed.campaignLaunch = { url: path, body };
      const launched = {
        ...campaignActive("cmp-synthetic-1"),
        ...(savedRoleScope && { roleScope: savedRoleScope }),
      };
      campaigns.splice(0, campaigns.length, launched);
      await route.fulfill({ status: 200, json: launched });
      return;
    }
    if (method === "POST" && path.endsWith("/stop")) {
      observed.campaignStop = { url: path, body };
      const stopped = {
        ...campaignStopped("cmp-synthetic-1"),
        ...(savedRoleScope && { roleScope: savedRoleScope }),
      };
      campaigns.splice(0, campaigns.length, stopped);
      await route.fulfill({ status: 200, json: stopped });
      return;
    }
    if (method === "GET" && /\/api\/personal\/[^/]+\/form-preview$/.test(path)) {
      observed.formPreviewGets.push(path);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>synthetic form</title><form><input disabled /></form>",
      });
      return;
    }
    if (method === "POST" && /\/api\/personal\/[^/]+\/render-review$/.test(path)) {
      observed.renderReviews.push({ url: path, body });
      await route.fulfill({ status: 200, json: previewRecord });
      return;
    }
    if (method === "POST" && /\/api\/personal\/[^/]+\/preview$/.test(path)) {
      observed.previewPosts.push(path);
      await route.fulfill({ status: 200, json: previewRecord });
      return;
    }
    if (method === "GET" && /\/api\/personal\/[^/]+\/pdf$/.test(path)) {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4 synthetic",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        records: emptyPage([]),
        sources: [],
        resume: null,
        capabilities: {
          personalMode: true,
          offlinePreview: true,
          liveSubmissions: false,
          missingSetup: [],
        },
      },
    });
  });

  observedByPage.set(page, observed);
  return observed;
}

/** No request may leave the harness origin or the mocked API/terminal hosts. */
export function expectOnlySyntheticTraffic(observed: Observed, harnessOrigin: string) {
  for (const url of observed.requests) {
    const allowed =
      url.startsWith(harnessOrigin) ||
      url.startsWith(`${API}/api/personal`) ||
      url.startsWith(`${API}/api/auth/tokens/terminal`) ||
      url.startsWith(`${TERMINAL}/workers/handoffs`);
    expect(allowed, `unexpected external request: ${url}`).toBe(true);
  }
}

export function observed(page: Page): Observed {
  const value = observedByPage.get(page);
  if (!value) throw new Error("page not observed");
  return value;
}
