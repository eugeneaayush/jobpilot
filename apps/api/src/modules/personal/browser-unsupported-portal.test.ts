import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonalBrowserBroker,
  PlaywrightDriver,
} from "../../../../../plugin/scripts/personal-browser/core";
import { describe, expect, test } from "bun:test";

const attemptId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  return value;
}

async function fixture(
  kind: "native_get" | "react_button" | "react_accessible",
  mode: "live_preview" | "submit",
) {
  const root = await mkdtemp(join(tmpdir(), "unsupported-portal-synthetic-"));
  const document = "%PDF-synthetic-unsupported-portal-fixture";
  const path = join(root, "synthetic-resume.pdf");
  await writeFile(path, document, { mode: 0o600 });
  let state = "preparing";
  const events: string[] = [];
  const employerRequests: { method: string; path: string; query: string }[] = [];
  const parks: { kind: string; reason: string; leaseOwner: string; leaseGeneration: number }[] = [];
  const manifest = {
    identity: "greenhouse:synthetic:123",
    canonicalUrl: "",
    document: { path, sha256: hash(document) },
    answers: [{ key: "email", fieldName: "email", value: "synthetic@example.test" }],
  };
  const fields =
    '<label>Email<input name="email" type="email" required></label><label>Resume<input name="resume" type="file" required></label>';
  let content = `<form action="/applications/submit" method="get">${fields}<button type="submit">Submit application</button></form>`;
  if (kind !== "native_get") {
    const button =
      kind === "react_accessible"
        ? "<button type=\"button\" aria-label=\"Send application\" onclick=\"fetch('/applications/submit',{method:'POST',body:'unapproved-inline-submit'})\">Continue</button>"
        : "<button type=\"button\" onclick=\"fetch('/applications/submit',{method:'POST',body:'unapproved-inline-submit'})\">Submit application</button>";
    content = `<form id="react-root" action="/applications/submit" method="post">${fields}${button}</form><footer>Example help text: sign in to continue. This fixture has no login control.</footer>`;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        if (request.headers.get("authorization") !== "Bearer synthetic-token")
          return new Response(null, { status: 401 });
        events.push(`${request.method} ${url.pathname}`);
        if (url.pathname === `/api/personal/attempts/${attemptId}`)
          return Response.json({
            id: attemptId,
            userId,
            recordId,
            mode,
            state,
            manifest,
            manifestHash: hash(JSON.stringify(stable(manifest))),
            leaseOwner: "synthetic-owner",
            leaseGeneration: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        if (url.pathname === `/api/personal/${recordId}`)
          return Response.json({
            id: recordId,
            title: "Synthetic Analyst",
            url: manifest.canonicalUrl,
            identity: manifest.identity,
            requisitionId: "123",
          });
        if (url.pathname.endsWith("/park")) {
          parks.push((await request.json()) as (typeof parks)[number]);
          state = "blocked";
          return Response.json({ state });
        }
        return new Response("Unexpected synthetic API action", { status: 409 });
      }
      employerRequests.push({ method: request.method, path: url.pathname, query: url.search });
      if (url.pathname === "/jobs/123")
        return new Response(
          `<!doctype html><html><body><h1>Synthetic Analyst</h1>${content}</body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      return new Response("Unexpected employer transmission", { status: 400 });
    },
  });
  const api = `http://127.0.0.1:${server.port}`;
  manifest.canonicalUrl = `${api}/jobs/123`;
  const broker = new PersonalBrowserBroker(
    {
      api,
      token: "synthetic-token",
      attemptId,
      leaseOwner: "synthetic-owner",
      leaseGeneration: 1,
      root,
    },
    new PlaywrightDriver(),
  );
  return {
    broker,
    parks,
    events,
    employerRequests,
    state: () => state,
    async close() {
      try {
        await broker.close();
      } finally {
        await server.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

describe("unsupported employer portal preparation holds", () => {
  for (const kind of ["native_get", "react_button", "react_accessible"] as const)
    for (const mode of ["live_preview", "submit"] as const)
      test(`${kind} in ${mode} parks for a portal adapter without a login handoff or applicant transmission`, async () => {
        const f = await fixture(kind, mode);
        try {
          // Keep Chromium startup outside Bun's asynchronous rejection matcher.
          let inspectionError: unknown;
          try {
            await f.broker.inspectForm();
          } catch (error) {
            inspectionError = error;
          }
          expect(inspectionError).toBeInstanceOf(Error);
          if (!(inspectionError instanceof Error))
            throw new Error("Expected an unsupported portal hold");
          expect(inspectionError.message).toContain(
            "Unsupported employer form; portal adapter required",
          );
          expect(f.state()).toBe("blocked");
          expect(f.parks).toHaveLength(1);
          expect(f.parks[0]).toMatchObject({
            kind: "blocked",
            leaseOwner: "synthetic-owner",
            leaseGeneration: 1,
          });
          expect(f.parks[0]?.reason).toContain("verified portal adapter");
          expect(f.parks[0]?.reason).toContain("cannot resolve this integration gap");
          await expect(f.broker.submitApplication()).rejects.toThrow();
          expect(f.events.filter((event) => /\/handoff\//.test(event))).toEqual([]);
          expect(
            f.events.filter((event) => /\/(prepare|begin-submit|receipt)$/.test(event)),
          ).toEqual([]);
          expect(
            f.employerRequests.filter((request) => request.path === "/applications/submit"),
          ).toEqual([]);
          expect(
            f.employerRequests.filter((request) => request.method !== "GET" || request.query),
          ).toEqual([]);
          expect(f.employerRequests.filter((request) => request.path === "/jobs/123")).toHaveLength(
            1,
          );
          expect(JSON.stringify(f.employerRequests)).not.toContain("synthetic@example.test");
        } finally {
          await f.close();
        }
      }, 30_000);
});
