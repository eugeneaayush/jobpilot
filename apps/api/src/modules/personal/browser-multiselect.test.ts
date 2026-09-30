import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonalScreeningAnswer } from "@jobpilot/contracts/personal-readiness";
import {
  type BrowserDriver,
  type Field,
  PersonalBrowserBroker,
  PlaywrightDriver,
} from "../../../../../plugin/scripts/personal-browser/core";
import { manifestHash } from "./persistence-policy";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
async function fixture(
  options: {
    value?: PersonalScreeningAnswer["value"];
    partial?: boolean;
    selected?: string[];
    repeated?: boolean;
    labelOnly?: boolean;
    wrongName?: boolean;
    real?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "multiselect-broker-synthetic-"));
  let url = "";
  const fields: Field[] = [
    {
      ref: "teams-ref",
      name: "teams",
      label: "Preferred teams",
      type: "select",
      required: true,
      value: "",
      multiple: true,
      selectedValues: options.selected ?? [],
      options: ["901", "902", "903"],
    },
  ];
  if (options.repeated) fields.push({ ...fields[0]!, name: "other_teams", ref: "other-ref" });
  let fills = 0,
    posts = 0;
  const answer = {
    key: "teams",
    fieldName: "teams",
    label: "Preferred teams",
    value: options.value ?? ["901", "902"],
  };
  if (options.labelOnly) Object.assign(answer, { fieldName: undefined });
  if (options.wrongName) answer.fieldName = "other_teams";
  const manifest = { identity: "greenhouse:synthetic:123", canonicalUrl: "", answers: [answer] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `/api/personal/attempts/${attemptId}`)
        return Response.json({
          id: attemptId,
          userId,
          recordId,
          mode: "live_preview",
          state: "preparing",
          manifest,
          manifestHash: manifestHash(manifest),
          leaseOwner: "fixture-owner",
          leaseGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      if (path === `/api/personal/${recordId}`)
        return Response.json({
          id: recordId,
          title: "Synthetic Analyst",
          url,
          identity: manifest.identity,
          requisitionId: "123",
        });
      if (path.endsWith("/authorize-transmission")) return Response.json({ status: "authorized" });
      if (request.method !== "GET") posts++;
      return new Response(
        '<h1>Synthetic Analyst</h1><form method="post"><label>Preferred teams<select multiple required name="teams"><option value="901">Research</option><option value="902">Trading</option><option value="903">Operations</option></select></label><button type="submit">Submit application</button></form>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  url = `http://127.0.0.1:${server.port}/jobs/123`;
  manifest.canonicalUrl = url;
  const fake: BrowserDriver = {
    async open() {},
    async snapshot() {
      return {
        url,
        text: "Synthetic Analyst",
        fields: fields.map((field) => ({ ...field })),
        submitCount: 1,
        submitMethod: "POST",
        submitAction: url,
        securityBlock: false,
      };
    },
    async fill(field, value) {
      fills++;
      const current = fields.find((item) => item.name === field.name)!;
      if (Array.isArray(value)) {
        current.selectedValues = [...value].reverse();
        if (options.partial) current.selectedValues.pop();
        current.value = current.selectedValues[0] ?? "";
      }
    },
    async upload() {},
    async submit() {
      throw new Error("Synthetic fill must stop before submission");
    },
    async close() {},
  };
  const driver = options.real ? new PlaywrightDriver() : fake;
  const broker = new PersonalBrowserBroker(
    {
      api: `http://127.0.0.1:${server.port}`,
      token: "synthetic-token",
      attemptId,
      leaseOwner: "fixture-owner",
      leaseGeneration: 1,
      root,
    },
    driver,
  );
  return {
    broker,
    fields,
    driver,
    counts: () => ({ fills, posts }),
    async close() {
      await broker.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("complete multiselect broker authority", () => {
  test("confirms every approved selection after refreshed readback", async () => {
    const f = await fixture();
    try {
      await f.broker.inspectForm();
      expect((await f.broker.fillField("teams-ref", "answer-0")).status).toBe("filled");
      expect(f.fields[0]!.selectedValues).toEqual(["902", "901"]);
      expect(f.counts().fills).toBe(1);
    } finally {
      await f.close();
    }
  });
  test("partial readback never reports completion", async () => {
    const f = await fixture({ partial: true });
    try {
      await f.broker.inspectForm();
      await expect(f.broker.fillField("teams-ref", "answer-0")).rejects.toThrow(
        "not confirmed after filling",
      );
    } finally {
      await f.close();
    }
  });
  test("rejects unknown, duplicate and scalar choices before filling", async () => {
    for (const value of [["901", "999"], ["901", "901"], "901"]) {
      const f = await fixture({ value });
      try {
        await f.broker.inspectForm();
        await expect(f.broker.fillField("teams-ref", "answer-0")).rejects.toThrow(
          "complete exact approved option set",
        );
        expect(f.counts().fills).toBe(0);
      } finally {
        await f.close();
      }
    }
  });
  test("preserves prior selections that conflict with the exact approved set", async () => {
    const f = await fixture({ selected: ["903"] });
    try {
      await f.broker.inspectForm();
      await expect(f.broker.fillField("teams-ref", "answer-0")).rejects.toThrow(
        "Existing selections conflict",
      );
      expect(f.fields[0]!.selectedValues).toEqual(["903"]);
      expect(f.counts().fills).toBe(0);
    } finally {
      await f.close();
    }
  });
  test("explicit field name cannot fall back to a shared label", async () => {
    const f = await fixture({ wrongName: true });
    try {
      expect(JSON.stringify(await f.broker.inspectForm())).toContain('"answerKey":null');
      await expect(f.broker.fillField("teams-ref", "answer-0")).rejects.toThrow("field identity");
      expect(f.counts().fills).toBe(0);
    } finally {
      await f.close();
    }
  });
  test("label fallback requires one observed control with that label", async () => {
    const f = await fixture({ repeated: true, labelOnly: true });
    try {
      const inspection = await f.broker.inspectForm();
      expect(inspection.fields.every((field) => field.answerKey === null)).toBe(true);
      await expect(f.broker.fillField("teams-ref", "answer-0")).rejects.toThrow("field identity");
      expect(f.counts().fills).toBe(0);
    } finally {
      await f.close();
    }
  });
  test("native Chromium multiselect fills exact values and stops before submission", async () => {
    const f = await fixture({ real: true });
    try {
      const inspection = await f.broker.inspectForm();
      const ref = inspection.fields[0]!.ref;
      expect((await f.broker.fillField(ref, "answer-0")).status).toBe("filled");
      const actual = (await f.driver.snapshot()).fields[0]!;
      expect(actual.selectedValues).toEqual(["901", "902"]);
      expect(f.counts().posts).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);
});
