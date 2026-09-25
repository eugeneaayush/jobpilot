import { personalSettingsSchema } from "@jobpilot/contracts/personal";
import { personalScreeningAnswersInputSchema } from "@jobpilot/contracts/personal-readiness";
import { preparedCampaignAnswers } from "./campaign-policy";
import {
  exactPointerValue,
  missingPersonalSettings,
  probeTerminalReadiness,
  requireExactAnswer,
  requireSettingsAnswer,
} from "./readiness-policy";
import { describe, expect, it } from "bun:test";

describe("factual personal readiness", () => {
  it("reports optional unknown facts per job without inferring identity or authorization", () => {
    const missing = missingPersonalSettings(personalSettingsSchema.parse({}));
    expect(missing.find((item) => item.field === "citizenship")).toMatchObject({
      scope: "per_job",
    });
    expect(missing.find((item) => item.field === "workAuthorization")).toMatchObject({
      scope: "per_job",
    });
    expect(missing.every((item) => item.scope === "per_job")).toBe(true);
    const known = missingPersonalSettings(
      personalSettingsSchema.parse({ workAuthorization: false, requiresSponsorship: true }),
    );
    expect(known.some((item) => item.field === "workAuthorization")).toBe(false);
    expect(known.some((item) => item.field === "workAuthorizationCountries")).toBe(true);
  });
  it("only copies settings authorization answers into records with the matching jurisdiction", () => {
    const settings = personalSettingsSchema.parse({
      workAuthorization: true,
      workAuthorizationCountries: ["US"],
      availabilityNotes: "Part-time now",
    });
    expect(() =>
      requireSettingsAnswer(true, settings, "/workAuthorization", "New York"),
    ).not.toThrow();
    for (const location of [null, "London", "Remote", "New York / London"])
      expect(() => requireSettingsAnswer(true, settings, "/workAuthorization", location)).toThrow(
        "jurisdiction",
      );
    expect(() =>
      requireSettingsAnswer(
        true,
        { ...settings, workAuthorizationCountries: [] },
        "/workAuthorization",
        "New York",
      ),
    ).toThrow("jurisdiction");
    expect(() => requireSettingsAnswer(false, settings, "/workAuthorization", "New York")).toThrow(
      "exactly match",
    );
    expect(() =>
      requireSettingsAnswer("Part-time now", settings, "/availabilityNotes", null),
    ).not.toThrow();
  });
  it("reads only exact owned JSON pointers and refuses invented transformations", () => {
    const facts = {
      citizenship: null,
      workAuthorization: false,
      "a/b": { "x~y": "Exact source text" },
    };
    expect(exactPointerValue(facts, "/a~1b/x~0y")).toBe("Exact source text");
    expect(() => exactPointerValue(facts, "/__proto__/toString")).toThrow("known stored");
    expect(() => requireExactAnswer("United States", facts.citizenship)).toThrow("exactly match");
    expect(() => requireExactAnswer("No", facts.workAuthorization)).toThrow("exactly match");
    expect(() => requireExactAnswer("false", facts.workAuthorization)).not.toThrow();
    expect(() =>
      requireExactAnswer("Exact source text", exactPointerValue(facts, "/a~1b/x~0y")),
    ).not.toThrow();
  });
  it("scopes either sponsorship answer to the explicitly established jurisdiction", () => {
    for (const requiresSponsorship of [true, false]) {
      const settings = personalSettingsSchema.parse({
        workAuthorization: false,
        workAuthorizationCountries: ["US"],
        requiresSponsorship,
      });
      for (const value of [requiresSponsorship, String(requiresSponsorship)]) {
        expect(() =>
          requireSettingsAnswer(value, settings, "/requiresSponsorship", "New York"),
        ).not.toThrow();
        for (const location of [null, "London", "Remote", "Worldwide", "New York / London"])
          expect(() =>
            requireSettingsAnswer(value, settings, "/requiresSponsorship", location),
          ).toThrow("jurisdiction");
        expect(() =>
          requireSettingsAnswer(
            value,
            { ...settings, workAuthorizationCountries: [] },
            "/requiresSponsorship",
            "New York",
          ),
        ).toThrow("jurisdiction");
      }
      expect(() =>
        requireSettingsAnswer(!requiresSponsorship, settings, "/requiresSponsorship", "New York"),
      ).toThrow("exactly match");
      expect(() =>
        requireSettingsAnswer(
          requiresSponsorship,
          { ...settings, workAuthorizationCountries: ["GB"] },
          "/requiresSponsorship",
          "London",
        ),
      ).not.toThrow();
    }
  });
  it("preserves explicit boolean answers through validation and campaign manifests", () => {
    const answers = [
      {
        key: "consent",
        value: false,
        fieldName: "consent",
        source: { kind: "explicit_user", confirmed: true },
      },
    ];
    const parsed = personalScreeningAnswersInputSchema.parse({
      expectedUpdatedAt: new Date().toISOString(),
      answers,
    });
    expect(parsed.answers[0]?.value).toBe(false);
    expect(preparedCampaignAnswers(parsed.answers)).toEqual([
      { key: "consent", value: false, fieldName: "consent" },
    ]);
    expect(() => requireExactAnswer(false, false)).not.toThrow();
    expect(() => requireExactAnswer(true, false)).toThrow("exactly match");
    expect(() => requireExactAnswer(false, "false")).toThrow("exactly match");
  });
  it("requires explicit confirmation and unique answer keys", () => {
    const base = {
      expectedUpdatedAt: new Date().toISOString(),
      answers: [
        {
          key: "question",
          value: "Exact answer",
          source: { kind: "explicit_user", confirmed: true },
        },
      ],
    };
    expect(personalScreeningAnswersInputSchema.safeParse(base).success).toBe(true);
    expect(
      personalScreeningAnswersInputSchema.safeParse({
        ...base,
        answers: [{ ...base.answers[0], source: { kind: "explicit_user", confirmed: false } }],
      }).success,
    ).toBe(false);
    expect(
      personalScreeningAnswersInputSchema.safeParse({
        ...base,
        answers: [...base.answers, ...base.answers],
      }).success,
    ).toBe(false);
  });
  it("uses a bounded authenticated loopback probe and returns capability evidence without secrets", async () => {
    let request: RequestInit | undefined;
    let url = "";
    const fetcher = async (input: string | URL | Request, options?: RequestInit) => {
      url = String(input);
      request = options;
      return Response.json({
        structuredTasks: true,
        mock: true,
        brokerConfigured: true,
        codexSupervisorEnabled: false,
        codexSupervisorBlockReason: "Unverified boundary",
        providers: [
          { id: "codex", installed: true, version: "test-version" },
          { id: "claude", installed: false, version: null },
        ],
      });
    };
    const result = await probeTerminalReadiness("synthetic-secret", fetcher);
    expect(url).toBe("http://127.0.0.1:4102/workers/capabilities");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.redirect).toBe("error");
    expect(result.status).toBe("available");
    expect(result.codexSupervisorEnabled).toBe(false);
    expect(result.blockReason).toBe("Unverified boundary");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("requires current terminal provider verification and fails closed for old capabilities or drift", async () => {
    const capabilities = {
      structuredTasks: true,
      mock: true,
      brokerConfigured: true,
      codexSupervisorEnabled: true,
      providers: [],
    };
    const old = await probeTerminalReadiness("x", async () => Response.json(capabilities));
    expect(old.providerApproved).toBe(false);
    expect(old.providerApprovalScope).toBeNull();
    const verified = await probeTerminalReadiness("x", async () =>
      Response.json({
        ...capabilities,
        providerApproved: true,
        providerApprovalScope: "metadata_only",
      }),
    );
    expect(verified.providerApproved).toBe(true);
    expect(verified.providerApprovalScope).toBe("metadata_only");
    const drifted = await probeTerminalReadiness("x", async () =>
      Response.json({
        ...capabilities,
        providerApproved: false,
        providerApprovalScope: "metadata_only",
        providerApprovalBlockReason: "Provider configuration or broker changed",
      }),
    );
    expect(drifted.providerApproved).toBe(false);
    expect(drifted.providerApprovalScope).toBeNull();
    expect(drifted.providerApprovalBlockReason).toBe("Provider configuration or broker changed");
  });
  it("does not claim readiness when authentication, response, or terminal checks fail", async () => {
    expect((await probeTerminalReadiness(null)).status).toBe("needs_auth");
    expect(
      (await probeTerminalReadiness("x", async () => new Response("", { status: 401 }))).status,
    ).toBe("needs_auth");
    expect(
      (await probeTerminalReadiness("x", async () => Response.json({ available: true }))).status,
    ).toBe("unavailable");
    expect(
      (
        await probeTerminalReadiness("x", async () => {
          throw new Error("secret detail");
        })
      ).blockReason,
    ).not.toContain("secret detail");
  });
});
