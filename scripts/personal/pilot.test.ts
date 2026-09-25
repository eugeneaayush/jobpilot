import type { PersonalCampaign } from "../../packages/contracts/src/personal-campaign";
import type { RuntimeConfig } from "./common";
import { advance as advancePilot } from "./pilot";
import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});
const advance: typeof advancePilot = (config, state, campaigns, persist = async () => {}) =>
  advancePilot(config, state, campaigns, persist);
const config: RuntimeConfig = {
  apiEnv: {},
  sourceJsonPath: "",
  sourceDocxPath: "",
  comparisonPaths: [],
  candidate: {},
  boardToken: "fixture",
  account: { email: "synthetic@example.test", password: "unused", token: "synthetic-token" },
};
const active = [{ id: "campaign" }] as PersonalCampaign[];
function fixture(): Parameters<typeof advance>[1] {
  return {
    owner: "fixture-owner",
    discoveries: {},
    status: "queued",
    updatedAt: "",
    current: {
      phase: "worker",
      startedAt: Date.now(),
      leased: {
        status: "task",
        campaignId: "campaign",
        mode: "submit",
        attempt: {
          id: "attempt",
          leaseOwner: "owner",
          leaseGeneration: 1,
          manifestHash: "hash",
          state: "prepared",
        },
        record: {
          id: "record",
          identity: "fixture",
          title: "Synthetic role",
          company: "Fixture",
          url: "https://example.test/job",
          track: "mba_internship",
        },
        task: { kind: "apply", attemptId: "attempt", brokerPath: "/fixture" },
      },
      request: { taskId: "same-task", role: "worker", adapter: "mock", kind: "apply", input: {} },
    },
  };
}
function attempt(state = "prepared") {
  return {
    state,
    leaseOwner: "owner",
    leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    manifestHash: "hash",
    receipt: null as { outcome: string } | null,
  };
}

test("a busy handoff worker slot keeps the same queued task and renews its lease", async () => {
  const state = fixture();
  const calls: string[] = [];
  let busy = true;
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt());
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/same-task") return new Response(null, { status: 404 });
    if (route === "/workers/tasks") {
      expect(JSON.parse(String(init?.body)).taskId).toBe("same-task");
      return busy
        ? Response.json({ detail: "This user's worker slot is already active." }, { status: 409 })
        : Response.json({ status: "running" });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.status).toContain("remains queued");
  expect(state.current?.request.taskId).toBe("same-task");
  busy = false;
  await advance(config, state, active);
  expect(state.status).toContain("Execution worker processing");
  expect(calls.filter((call) => call.endsWith("/checkpoint"))).toHaveLength(2);
  expect(calls.some((call) => call.endsWith("/park") || call.endsWith("/cancel"))).toBe(false);
});

test("a broker-created parked handoff is not parked again using the stale execution lease", async () => {
  const state = fixture();
  const calls: string[] = [];
  let parked = false;
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt")
      return Response.json(attempt(parked ? "blocked" : "prepared"));
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/same-task") {
      parked = true;
      return Response.json({ status: "needs_user" });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current).toBeUndefined();
  expect(calls.some((call) => call.endsWith("/park"))).toBe(false);
});

test("worker status transport failures do not create another execution request", async () => {
  const state = fixture();
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt());
    if (route.endsWith("/checkpoint")) return Response.json({});
    return Response.json({ detail: "unavailable" }, { status: 503 });
  }) as typeof fetch;
  await expect(advance(config, state, active)).rejects.toThrow();
  expect(calls).not.toContain("POST /workers/tasks");
  expect(state.current?.request.taskId).toBe("same-task");
});

test("an ended worker parks its own submitting lease to uncertainty and verifies read-back", async () => {
  const state = fixture();
  const calls: string[] = [];
  const stored = attempt("submitting");
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route === "/workers/tasks/same-task")
      return Response.json({ status: "outcome_unknown", submissionPossible: true });
    if (route.endsWith("/park")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        leaseOwner: "owner",
        leaseGeneration: 1,
        kind: "blocked",
        reason: "Local worker outcome: outcome_unknown",
      });
      stored.state = "submission_uncertain";
      stored.leaseGeneration = 2;
      return Response.json({}); // Only the subsequent authoritative GET confirms settlement.
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current).toBeUndefined();
  expect(state.status).toContain("uncertain");
  expect(state.status).toContain("reconciliation required");
  expect(calls.slice(-2)).toEqual([
    "POST /api/personal/attempts/attempt/park",
    "GET /api/personal/attempts/attempt",
  ]);
  expect(calls.some((call) => call.endsWith("/cancel") || call.endsWith("/checkpoint"))).toBe(
    false,
  );
});

test("a failed uncertainty transition retains the current task and reports no false parking", async () => {
  const state = fixture();
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt("submitting"));
    if (route === "/workers/tasks/same-task") return Response.json({ status: "outcome_unknown" });
    if (route.endsWith("/park")) return Response.json({}, { status: 503 });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await expect(advance(config, state, active)).rejects.toThrow("HTTP 503");
  expect(state.current?.request.taskId).toBe("same-task");
  expect(state.status).toContain("waiting for an authoritative");
  expect(state.status).not.toContain("parked");
});

test("a successful park response without a settled read-back retains the current task", async () => {
  const state = fixture();
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt("submitting"));
    if (route === "/workers/tasks/same-task") return Response.json({ status: "completed" });
    if (route.endsWith("/park")) return Response.json({ state: "submission_uncertain" });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(state.status).toContain("submission remains unresolved");
});

for (const resolvedState of ["submission_uncertain", "submitted"]) {
  test(`a stale park fence clears only after authoritative ${resolvedState}`, async () => {
    const state = fixture();
    const stored = attempt("submitting");
    globalThis.fetch = (async (input) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/personal/attempts/attempt") return Response.json(stored);
      if (route === "/workers/tasks/same-task") return Response.json({ status: "outcome_unknown" });
      if (route.endsWith("/park")) {
        stored.state = resolvedState;
        stored.leaseGeneration = 2;
        stored.receipt = { outcome: resolvedState };
        return Response.json({}, { status: 409 });
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await advance(config, state, active);
    expect(state.current).toBeUndefined();
    expect(state.status).toContain(
      resolvedState === "submitted" ? "confirmation recorded" : "reconciliation required",
    );
  });
}

test("a different submitting lease is not parked or forgotten", async () => {
  const state = fixture();
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt")
      return Response.json({
        ...attempt("submitting"),
        leaseGeneration: 2,
        leaseOwner: "new-owner",
      });
    if (route === "/workers/tasks/same-task") return Response.json({ status: "outcome_unknown" });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(state.status).toContain("submission remains unresolved");
  expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
});

test("submission beginning during the final worker poll is settled with the original lease", async () => {
  const state = fixture();
  const stored = attempt();
  let parks = 0;
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/same-task") {
      stored.state = "submitting";
      return Response.json({ status: "failed" });
    }
    if (route.endsWith("/park")) {
      parks++;
      stored.state = "submission_uncertain";
      return Response.json({});
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(parks).toBe(1);
  expect(state.current).toBeUndefined();
  expect(state.status).toContain("reconciliation required");
});

test("failed read-back after parking retains identity for recovery", async () => {
  const state = fixture();
  let parked = false;
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/attempts/attempt")
      return parked ? new Response(null, { status: 503 }) : Response.json(attempt("submitting"));
    if (route === "/workers/tasks/same-task") return Response.json({ status: "outcome_unknown" });
    if (route.endsWith("/park")) {
      parked = true;
      return Response.json({ state: "submission_uncertain" });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await expect(advance(config, state, active)).rejects.toThrow("HTTP 503");
  expect(state.current?.request.taskId).toBe("same-task");
});

test("cancelling workers still own execution and are not settled early", async () => {
  const state = fixture();
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt("submitting"));
    if (route === "/workers/tasks/same-task") return Response.json({ status: "cancelling" });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
});

for (const stopReason of ["campaign", "deadline"]) {
  test(`${stopReason} stop retains submitting until terminal exit and verified uncertainty`, async () => {
    const state = fixture();
    if (stopReason === "deadline") state.current!.startedAt = Date.now() - 16 * 60_000;
    const campaigns = stopReason === "campaign" ? [] : active;
    const stored = attempt("submitting");
    let terminalStatus = "cancelling";
    let parks = 0;
    globalThis.fetch = (async (input, init) => {
      const route = new URL(String(input)).pathname;
      if (route === "/workers/tasks/same-task/cancel" || route === "/workers/tasks/same-task")
        return Response.json({ status: terminalStatus });
      if (route === "/api/personal/attempts/attempt") return Response.json(stored);
      if (route.endsWith("/park")) {
        parks++;
        const body = JSON.parse(String(init?.body));
        expect(body.leaseOwner).toBe("owner");
        expect(body.leaseGeneration).toBe(1);
        stored.state = "submission_uncertain";
        stored.leaseGeneration = 2;
        return Response.json({});
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await advance(config, state, campaigns);
    expect(state.current?.request.taskId).toBe("same-task");
    expect(state.status).toContain("submission remains unresolved");
    expect(parks).toBe(0);
    terminalStatus = "outcome_unknown";
    await advance(config, state, campaigns);
    expect(parks).toBe(1);
    expect(state.current).toBeUndefined();
    expect(state.status).toContain("reconciliation required");
  });
}

test("stopped preparation uses cancellation and clears only after read-back", async () => {
  const state = fixture();
  const stored = attempt();
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/workers/tasks/same-task/cancel") return Response.json({ status: "cancelling" });
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route === "/api/personal/attempts/attempt/cancel") {
      expect(JSON.parse(String(init?.body))).toEqual({ leaseOwner: "owner", leaseGeneration: 1 });
      stored.state = "cancelled";
      stored.leaseGeneration = 2;
      return Response.json({});
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, []);
  expect(state.current).toBeUndefined();
  expect(state.status).toContain("cancelled");
  expect(calls.slice(-2)).toEqual([
    "POST /api/personal/attempts/attempt/cancel",
    "GET /api/personal/attempts/attempt",
  ]);
  expect(calls.some((call) => call.endsWith("/park"))).toBe(false);
});

for (const stoppedState of ["prepared", "submitting"]) {
  test(`failed stop transition preserves ${stoppedState} identity`, async () => {
    const state = fixture();
    globalThis.fetch = (async (input) => {
      const route = new URL(String(input)).pathname;
      if (route === "/workers/tasks/same-task/cancel")
        return Response.json({ status: "outcome_unknown" });
      if (route === "/api/personal/attempts/attempt") return Response.json(attempt(stoppedState));
      if (route.endsWith("/park") || route.endsWith("/cancel"))
        return new Response(null, { status: 503 });
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await expect(advance(config, state, [])).rejects.toThrow("HTTP 503");
    expect(state.current?.request.taskId).toBe("same-task");
    expect(state.status).toContain("waiting for an authoritative");
  });
}

for (const resolvedState of ["submission_uncertain", "submitted"]) {
  test(`stopped submission resolves a stale park fence only from authoritative ${resolvedState}`, async () => {
    const state = fixture();
    const stored = attempt("submitting");
    globalThis.fetch = (async (input) => {
      const route = new URL(String(input)).pathname;
      if (route === "/workers/tasks/same-task/cancel")
        return Response.json({ status: "outcome_unknown" });
      if (route === "/api/personal/attempts/attempt") return Response.json(stored);
      if (route.endsWith("/park")) {
        stored.state = resolvedState;
        stored.leaseGeneration = 2;
        stored.receipt = { outcome: resolvedState };
        return new Response(null, { status: 409 });
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await advance(config, state, []);
    expect(state.current).toBeUndefined();
    expect(state.status).toContain(
      resolvedState === "submitted" ? "confirmation recorded" : "reconciliation required",
    );
  });
}

test("unknown terminal cancellation retains submission until the API independently resolves it", async () => {
  const state = fixture();
  const stored = attempt("submitting");
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/workers/tasks/same-task/cancel") return new Response(null, { status: 503 });
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, []);
  expect(state.current?.request.taskId).toBe("same-task");
  stored.state = "submission_uncertain";
  stored.leaseGeneration = 2;
  await advance(config, state, []);
  expect(state.current).toBeUndefined();
  expect(state.status).toContain("reconciliation required");
});

test("stopped submitting attempt remains tracked after an unconfirmed successful park", async () => {
  const state = fixture();
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/workers/tasks/same-task/cancel")
      return Response.json({ status: "outcome_unknown" });
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt("submitting"));
    if (route.endsWith("/park")) return Response.json({ state: "submission_uncertain" });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, []);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(state.status).toContain("submission remains unresolved");
});

test("stop does not cancel or park a lease owned by another execution", async () => {
  const state = fixture();
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/workers/tasks/same-task/cancel")
      return Response.json({ status: "outcome_unknown" });
    if (route === "/api/personal/attempts/attempt")
      return Response.json({
        ...attempt("submitting"),
        leaseOwner: "new-owner",
        leaseGeneration: 2,
      });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, []);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(state.status).toContain("submission remains unresolved");
});

for (const reason of ["campaign", "deadline"]) {
  test(`${reason} cancellation persists a three-request limit and settles after host recovery`, async () => {
    let now = originalNow();
    Date.now = () => now;
    let state = fixture();
    if (reason === "deadline") state.current!.startedAt = now - 16 * 60_000;
    const campaigns = reason === "campaign" ? [] : active;
    const stored = attempt("submitting");
    let saved = "";
    let cancels = 0;
    let probes = 0;
    let recovered = false;
    const persist = async (value: typeof state) => {
      saved = JSON.stringify(value);
    };
    globalThis.fetch = (async (input, init) => {
      const route = new URL(String(input)).pathname;
      if (route === "/workers/tasks/same-task/cancel") {
        cancels++;
        expect(JSON.parse(saved).current.cancelAttempts).toBe(cancels);
        return new Response(null, { status: 503 });
      }
      if (route === "/workers/tasks/same-task") {
        probes++;
        return recovered
          ? Response.json({ status: "outcome_unknown", submissionPossible: true })
          : new Response(null, { status: 503 });
      }
      if (route === "/api/personal/attempts/attempt") return Response.json(stored);
      if (route.endsWith("/park")) {
        expect(recovered).toBe(true);
        expect(JSON.parse(String(init?.body)).kind).toBe("blocked");
        stored.state = "submission_uncertain";
        return Response.json({});
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    for (const elapsed of [0, 0, 30_000, 59_999, 1, 120_000, 120_000]) {
      now += elapsed;
      await advance(config, state, campaigns, persist);
      expect(state.current?.request.taskId).toBe("same-task");
      state = JSON.parse(JSON.stringify(state));
    }
    expect(cancels).toBe(3);
    expect(probes).toBe(4);
    expect(state.current?.cancelAttempts).toBe(3);
    recovered = true;
    await advance(config, state, campaigns, persist);
    expect(cancels).toBe(3);
    expect(state.current).toBeUndefined();
    expect(state.status).toContain("reconciliation required");
  });
}

test("API cancellation also backs off and stops after three attempts until terminal exit", async () => {
  let now = originalNow();
  Date.now = () => now;
  let state = fixture();
  const stored = attempt();
  let ended = false;
  let cancellations = 0;
  let saved = "";
  const persist = async (value: typeof state) => {
    saved = JSON.stringify(value);
  };
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route.startsWith("/workers/tasks/same-task"))
      return Response.json({ status: ended ? "cancelled" : "cancelling" });
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route.endsWith("/cancel")) {
      cancellations++;
      expect(JSON.parse(saved).current.attemptCancelAttempts).toBe(cancellations);
      return new Response(null, { status: 503 });
    }
    if (route.endsWith("/park")) {
      expect(ended).toBe(true);
      stored.state = "blocked";
      return Response.json({});
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  for (const elapsed of [0, 30_000, 60_000]) {
    now += elapsed;
    await expect(advance(config, state, [], persist)).rejects.toThrow("HTTP 503");
    state = JSON.parse(saved);
  }
  for (let i = 0; i < 3; i++) {
    now += 120_000;
    await advance(config, state, [], persist);
    expect(state.current?.request.taskId).toBe("same-task");
  }
  expect(cancellations).toBe(3);
  ended = true;
  await advance(config, state, [], persist);
  expect(cancellations).toBe(3);
  expect(state.current).toBeUndefined();
});

test("interrupted preparation has two persisted automatic resumes, including lost replies", async () => {
  let now = originalNow();
  Date.now = () => now;
  let state = fixture();
  const stored = attempt();
  stored.leaseExpiresAt = new Date(now + 10 * 60_000).toISOString();
  let saved = "";
  let resumes = 0;
  const persist = async (value: typeof state) => {
    saved = JSON.stringify(value);
  };
  globalThis.fetch = (async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/same-task")
      return Response.json({ status: "interrupted", submissionPossible: false });
    if (route.endsWith("/resume")) {
      resumes++;
      expect(JSON.parse(saved).current.resumeAttempts).toBe(resumes);
      return new Response(null, { status: 503 });
    }
    if (route.endsWith("/park")) {
      stored.state = "blocked";
      return Response.json({});
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await expect(advance(config, state, active, persist)).rejects.toThrow("HTTP 503");
  state = JSON.parse(saved);
  await advance(config, state, active, persist);
  expect(resumes).toBe(1);
  expect(state.status).toContain("backoff");
  now += 30_000;
  await expect(advance(config, state, active, persist)).rejects.toThrow("HTTP 503");
  state = JSON.parse(saved);
  await advance(config, state, active, persist);
  expect(resumes).toBe(2);
  expect(state.current).toBeUndefined();
  expect(state.status).toContain("blocked");
});

for (const scenario of ["unknown", "possible", "submitting"]) {
  test(`${scenario} submission state never automatically resumes an interrupted worker`, async () => {
    const state = fixture();
    const stored = attempt(scenario === "submitting" ? "submitting" : "prepared");
    const posts: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const route = new URL(String(input)).pathname;
      if (init?.method === "POST") posts.push(route);
      if (route === "/api/personal/attempts/attempt") return Response.json(stored);
      if (route.endsWith("/checkpoint")) return Response.json({});
      if (route === "/workers/tasks/same-task") {
        const result: { status: string; submissionPossible?: boolean } = { status: "interrupted" };
        if (scenario !== "unknown") result.submissionPossible = scenario === "possible";
        return Response.json(result);
      }
      if (route.endsWith("/park")) {
        stored.state = scenario === "submitting" ? "submission_uncertain" : "blocked";
        return Response.json({});
      }
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await advance(config, state, active);
    expect(posts.some((route) => route.endsWith("/resume") || route === "/workers/tasks")).toBe(
      false,
    );
    expect(state.current).toBeUndefined();
  });
}

test("fresh submission state prevents resuming from an older pre-submit snapshot", async () => {
  const state = fixture();
  const stored = attempt();
  const posts: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (init?.method === "POST") posts.push(route);
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/same-task") {
      stored.state = "submitting";
      return Response.json({ status: "interrupted", submissionPossible: false });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(posts).toEqual(["/api/personal/attempts/attempt/checkpoint"]);
});

test("missing terminal task after begin-submit remains held without recreating execution", async () => {
  const state = fixture();
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${route}`);
    if (route === "/api/personal/attempts/attempt") return Response.json(attempt("submitting"));
    if (route === "/workers/tasks/same-task") return new Response(null, { status: 404 });
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
});

test("terminal 404 rechecks the API before recreating an apparently prepared task", async () => {
  const state = fixture();
  const stored = attempt();
  const posts: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (init?.method === "POST") posts.push(route);
    if (route === "/api/personal/attempts/attempt") return Response.json(stored);
    if (route.endsWith("/checkpoint")) return Response.json({});
    if (route === "/workers/tasks/same-task") {
      stored.state = "submitting";
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected synthetic request ${route}`);
  }) as typeof fetch;
  await advance(config, state, active);
  expect(state.current?.request.taskId).toBe("same-task");
  expect(posts).toEqual(["/api/personal/attempts/attempt/checkpoint"]);
});

for (const operation of ["resume", "cancel"]) {
  test(`${operation} is not sent when its retry counter cannot be persisted`, async () => {
    const state = fixture();
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const route = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${route}`);
      if (route === "/api/personal/attempts/attempt") return Response.json(attempt());
      if (route.endsWith("/checkpoint")) return Response.json({});
      if (route === "/workers/tasks/same-task")
        return Response.json({ status: "interrupted", submissionPossible: false });
      throw new Error(`Unexpected synthetic request ${route}`);
    }) as typeof fetch;
    await expect(
      advance(config, state, operation === "resume" ? active : [], async () => {
        throw new Error("Synthetic persistence failure");
      }),
    ).rejects.toThrow("Synthetic persistence failure");
    expect(calls.some((call) => call.endsWith(`/${operation}`))).toBe(false);
    expect(state.current?.request.taskId).toBe("same-task");
  });
}
