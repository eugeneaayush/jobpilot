import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  GreenhouseDriver,
  isGreenhousePosting,
} from "../../../../../plugin/scripts/personal-browser/greenhouse-driver";
import { describe, expect, test } from "bun:test";

const target = "https://boards.greenhouse.io/fixture/jobs/123";
const pageUrl = "https://job-boards.greenhouse.io/fixture/jobs/123";
const documentBytes = Buffer.from("%PDF-SYNTHETIC-ONLY");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function isolateRedirectBrowser(driver: GreenhouseDriver) {
  // Routed fixture responses still work offline. A regressed redirect guard must
  // not let Chromium's unrouted redirect fallback contact a real Greenhouse host.
  const context = (driver as unknown as { context?: { setOffline(value: boolean): Promise<void> } })
    .context;
  if (!context) throw new Error("Synthetic browser context missing");
  await context.setOffline(true);
}
async function fixture(
  options: {
    mode?: "success" | "challenge" | "lost" | "tamper" | "redirect";
    revoke?: boolean;
    probePreflight?: boolean;
    redirectInitial?: boolean;
    staleUploadReference?: boolean;
    eagerPresign?: boolean;
    progressRequired?: boolean;
    uploadFailure?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "greenhouse-driver-"));
  const events: string[] = [];
  const forwarded: { url: string; method: string }[] = [];
  const stagedUploads: { url: string; sha256: string; name: string }[] = [];
  const eagerPresignUrl =
    "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=resume&fields%5B%5D=cover_letter";
  const deniedPresignUrls = [
    "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=question_9999",
    "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=resume&token=SYNTHETIC_QUERY_CANARY",
    "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields",
    "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=",
  ];
  const initialUpload = options.staleUploadReference
    ? JSON.stringify({
        name: "synthetic.pdf",
        url: "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/stash/applications/resumes/1760000000000-syntheticid-synthetic",
      })
    : "undefined";
  let revoked = false;
  const loader = {
    urlToken: "fixture",
    jobPostId: "123",
    submitPath: target,
    confirmationPath: "/fixture/jobs/123/confirmation",
    jobPost: {
      id: 123,
      title: "Synthetic Analyst",
      public_url: pageUrl,
      hiring_plan_id: 456,
      post_type: "job_post",
      fingerprint: "synthetic-fingerprint",
      questions: [{ required: true, fields: [{ name: "resume", type: "input_file" }] }],
    },
  };
  const html = `<!doctype html><html><body><h1>Synthetic Analyst</h1>
  <form id="application-form" class="application--form"><label for="first_name">First Name*</label><input id="first_name" required><label for="last_name">Last Name*</label><input id="last_name" required><label for="email">Email*</label><input id="email" type="email" required>
  <div class="file-upload" role="group" aria-required="true" aria-labelledby="upload-label-resume"><label id="upload-label-resume" for="resume">Resume*</label><input id="resume" type="file"></div><button type="submit">Submit application</button></form>
  <script>window.__remixContext={state:{loaderData:{'routes/$url_token_.jobs_.$job_post_id':${JSON.stringify(loader)}}}};
  let uploaded=${initialUpload};
  ${
    options.eagerPresign
      ? `const prefetched=fetch(${JSON.stringify(eagerPresignUrl)}).then(r=>r.json());
  window.prefetchReady=Promise.all([prefetched.then(async p=>{await fetch(p.url,{method:'POST',body:'UNAPPROVED_SYNTHETIC_UPLOAD'}).catch(()=>{});return true},()=>false),Promise.all(${JSON.stringify(deniedPresignUrls)}.map(url=>fetch(url).then(()=>false,()=>true)))]).then(([ready,denied])=>({ready,denied}));`
      : ""
  }
  document.querySelector('#resume').addEventListener('change',async e=>{
    const f=e.target.files[0]; const p=${options.eagerPresign ? "await prefetched" : "await (await fetch('https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=resume')).json()"};
    const key=p.resume.key.replace('{timestamp}','1760000000000').replace('{unique_id}','syntheticid');
    const form=new FormData(); for(const [k,v] of Object.entries(p.resume.fields))form.append(k,v); form.append('utf8','✓'); form.append('key',key); form.append('authenticity_token','1234');form.append('Content-Type','application/octet-stream');form.append('file',f);
    ${options.probePreflight ? "const probe=await fetch(p.url,{method:'OPTIONS'});if(!probe.ok)throw new Error('Synthetic preflight probe failed');" : ""}
    let percentage=0;const render=()=>{if(uploaded&&(${options.progressRequired ? "percentage>=100" : "true"})&&e.target.isConnected){e.target.insertAdjacentHTML('afterend','<span class="file-upload__filename">'+f.name+'</span><button type="button">Remove</button>');e.target.remove();}};
    const r=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',p.url,true);xhr.upload.onprogress=e=>{percentage=e.loaded/e.total*100;render()};xhr.onload=()=>resolve({ok:xhr.status>=200&&xhr.status<300});xhr.onerror=()=>reject(new Error('Synthetic upload failed'));xhr.send(form)});if(r.ok) {uploaded={name:f.name,url:p.url+'/'+key};render();}
  });
  document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();
    const job_application={first_name:first_name.value,last_name:last_name.value,email:email.value,resume_url:uploaded.url,resume_url_filename:uploaded.name,from_job_board_renderer:true,answers_attributes:{},demographic_answers:[],data_compliance:{},attachments:{},employments:[{start_date:{month:null,year:null},end_date:{month:null,year:null},current:false}],educations:[{school_name_id:null,degree_id:null,discipline_id:null,start_date:{month:null,year:null},end_date:{month:null,year:null}}],mapped_url_token:null,appcast_click_id:null,time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone};
    ${options.mode === "tamper" ? "job_application.email='attacker@example.test';" : ""}
    const r=await fetch('${target}',{method:'POST',headers:{'content-type':'application/json','x-unapproved-data':'SYNTHETIC-HEADER-CANARY'},body:JSON.stringify({job_application,fingerprint:'synthetic-fingerprint','g-recaptcha-enterprise-token':'synthetic-site-token'})});
    if(r.ok)location.href='/fixture/jobs/123/confirmation';else document.body.insertAdjacentHTML('beforeend','<p>Verification required</p>');
  });
  fetch('https://email-address-validator.us.greenhouse.io/address/validate?address=leak@example.test').catch(()=>{});
  fetch('${target}',{method:'POST',body:'unauthorized'}).catch(()=>{});
  </script></body></html>`;
  const driver = new GreenhouseDriver({
    transport: async (request) => {
      const u = new URL(request.url);
      events.push(`${request.method} ${u.pathname}`);
      forwarded.push({ url: request.url, method: request.method });
      if (options.redirectInitial && request.method === "GET" && request.url === pageUrl) {
        await isolateRedirectBrowser(driver);
        return new Response(null, {
          status: 302,
          headers: { location: target },
        });
      }
      if (u.pathname.endsWith("/presigned_fields"))
        return Response.json(
          {
            url: "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com",
            ...Object.fromEntries(
              u.searchParams.getAll("fields[]").map((fieldName) => [
                fieldName,
                {
                  key: "stash/applications/resumes/{timestamp}-{unique_id}-synthetic",
                  fields: {
                    "x-amz-server-side-encryption": "AES256",
                    success_action_status: "201",
                    policy: Buffer.from(
                      JSON.stringify({
                        expiration: new Date(Date.now() + 60000).toISOString(),
                        conditions: [
                          { bucket: "grnhse-prod-jben-us-east-1" },
                          ["starts-with", "$key", "stash/applications/resumes"],
                          ["content-length-range", 1, 104857600],
                        ],
                      }),
                    ).toString("base64"),
                    "x-amz-credential": "synthetic-credential",
                    "x-amz-algorithm": "AWS4-HMAC-SHA256",
                    "x-amz-date": "20260916T000000Z",
                    "x-amz-signature": "a".repeat(64),
                  },
                },
              ]),
            ),
          },
          { headers: { "access-control-allow-origin": "*" } },
        );
      if (request.method === "OPTIONS") {
        expect(request.headers["access-control-request-method"]).toBe("POST");
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": u.host.endsWith(".s3.amazonaws.com")
              ? "content-type"
              : "content-type,x-unapproved-data",
          },
        });
      }
      if (u.host.endsWith(".s3.amazonaws.com")) {
        expect(request.method).toBe("POST");
        if (!request.body) throw new Error("Synthetic upload body missing");
        const form = await new Response(new Uint8Array(request.body), {
          headers: { "content-type": request.headers["content-type"] ?? "" },
        }).formData();
        const file = form.get("file");
        if (!(file instanceof File)) throw new Error("Synthetic upload file missing");
        stagedUploads.push({
          url: request.url,
          sha256: hash(new Uint8Array(await file.arrayBuffer())),
          name: file.name,
        });
        return new Response("", {
          status: options.uploadFailure ? 500 : 201,
          headers: { "access-control-allow-origin": "*" },
        });
      }
      if (request.method === "POST") {
        expect(request.headers["x-unapproved-data"]).toBeUndefined();
        if (options.mode === "lost") throw new Error("Synthetic lost response");
        if (options.mode === "redirect") {
          await isolateRedirectBrowser(driver);
          return new Response(null, {
            status: 307,
            headers: {
              location: `${pageUrl}/confirmation`,
              "access-control-allow-origin": "*",
            },
          });
        }
        if (options.mode === "challenge")
          return Response.json(
            { code: "captcha-failed", security_code_recipient: "s***@example.test" },
            { status: 422, headers: { "access-control-allow-origin": "*" } },
          );
        return Response.json({}, { headers: { "access-control-allow-origin": "*" } });
      }
      if (u.pathname.endsWith("/confirmation"))
        return new Response("<h1>Thank you for applying</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  driver.configure({
    attemptId: "11111111-1111-4111-8111-111111111111",
    manifestHash: hash("synthetic"),
    identity: "greenhouse:fixture:123",
    authorize: async () => {
      if (revoked) throw new Error("Revoked");
    },
    freeze: async () => {
      events.push("FROZEN");
      if (options.revoke) throw new Error("Stopped before transport");
    },
  });
  return {
    driver,
    events,
    forwarded,
    stagedUploads,
    eagerPresignUrl,
    deniedPresignUrls,
    async prefetchResult() {
      const page = (driver as unknown as { page: Page }).page;
      return page.evaluate(
        () =>
          (window as unknown as { prefetchReady: Promise<{ ready: boolean; denied: boolean[] }> })
            .prefetchReady,
      );
    },
    revoke: () => {
      revoked = true;
    },
    async open() {
      await driver.open(pageUrl, root);
    },
    async prepare() {
      await driver.open(pageUrl, root);
      const s = await driver.snapshot();
      for (const [name, value] of [
        ["first_name", "Synthetic"],
        ["last_name", "Applicant"],
        ["email", "synthetic@example.test"],
      ]) {
        const f = s.fields.find((f) => f.name === name);
        if (!f) throw new Error("Missing field");
        await driver.fill(f, value!);
      }
      const f = s.fields.find((f) => f.name === "resume");
      if (!f) throw new Error("Missing resume");
      await driver.upload(f, "synthetic.pdf", documentBytes);
      await driver.snapshot();
    },
    async close() {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("Greenhouse hosted driver", () => {
  for (const navigation of [
    {
      title:
        "waits for delayed SSR hydration through pinned locale resources and blocks unpinned resources",
      inputUrl: pageUrl,
      hostedUrl: pageUrl,
    },
    {
      title:
        "opens a legacy posting directly on its hosted origin, preserving identity and tracking query through hydration",
      inputUrl: `${target}?gh_src=synthetic-tracking&t=fixture&gh_jid=123&ccuid=synthetic-client`,
      hostedUrl: `${pageUrl}?gh_src=synthetic-tracking&t=fixture&gh_jid=123&ccuid=synthetic-client`,
    },
  ]) {
    test(navigation.title, async () => {
      const root = await mkdtemp(join(tmpdir(), "greenhouse-hydration-synthetic-"));
      const entryUrl = "https://job-boards.cdn.greenhouse.io/assets/entry.client-fixture1.js";
      const localeHashes = {
        "locales/en/common.json": "A".repeat(43),
        "locales/en/job_post.json": "B".repeat(43),
        "locales/en/confirmation.json": "C".repeat(43),
      };
      const locales = Object.entries(localeHashes).map(
        ([path, digest]) =>
          `https://job-boards.cdn.greenhouse.io/${path.replace(".json", `.${digest}.json`)}`,
      );
      const denied = [
        `https://job-boards.cdn.greenhouse.io/locales/en/common.${"D".repeat(43)}.json`,
        `https://job-boards.cdn.greenhouse.io/locales/fr/common.${"A".repeat(43)}.json`,
        "https://synthetic-third-party.invalid/locale.json",
      ];
      const forwarded: { url: string; method: string }[] = [];
      const authority: string[] = [];
      const loader = {
        urlToken: "fixture",
        jobPostId: "123",
        submitPath: target,
        confirmationPath: "/fixture/jobs/123/confirmation",
        jobPost: {
          id: 123,
          title: "Synthetic Hydration Role",
          public_url: pageUrl,
          post_type: "job_post",
          fingerprint: "synthetic-hydration-fingerprint",
          questions: [],
        },
      };
      const html = `<!doctype html><html><body><h1>Synthetic Hydration Role</h1><p id="hydration-state">SSR pending</p>
      <form id="application-form" class="application--form">
      <label for="first_name">First Name*</label><input id="first_name">
      <label for="last_name">Last Name*</label><input id="last_name">
      <label for="email">Email*</label><input id="email">
      <label for="country" id="country-label">Country*</label><div class="select-shell"><input id="country" role="combobox" aria-labelledby="country-label" aria-controls="country-listbox" aria-expanded="false" aria-required="true"></div>
      <button type="submit">Submit application</button></form>
      <script>window.__remixContext={state:{loaderData:{'routes/$url_token_.jobs_.$job_post_id':${JSON.stringify(loader)}}}};</script>
      <script defer src="${entryUrl}"></script></body></html>`;
      const entry = `const publishedLocaleHashes=${JSON.stringify(localeHashes)};
      async function hydrateSyntheticForm(){
        const localeUrls=${JSON.stringify(locales)};
        const blockedUrls=${JSON.stringify(denied)};
        const blocked=await Promise.all(blockedUrls.map(url=>fetch(url).then(()=>false,()=>true)));
        await Promise.all(localeUrls.map(url=>fetch(url).then(response=>{if(!response.ok)throw new Error('Synthetic locale unavailable');return response.json()})));
        const country=document.getElementById('country');
        country.onclick=()=>{country.closest('.select-shell').querySelector('[role=listbox]')?.remove();const list=document.createElement('div');list.id='country-listbox';list.setAttribute('role','listbox');const option=document.createElement('div');option.setAttribute('role','option');option.textContent='United States +1';list.append(option);country.closest('.select-shell').append(list);country.setAttribute('aria-expanded','true')};
        country.onkeydown=event=>{if(event.key==='Escape'){country.closest('.select-shell').querySelector('[role=listbox]')?.remove();country.setAttribute('aria-expanded','false')}};
        document.getElementById('hydration-state').textContent=blocked.every(Boolean)?'Hydrated; unpinned resources blocked':'Unexpected unpinned resource';
      }
      void hydrateSyntheticForm();`;
      const driver = new GreenhouseDriver({
        transport: async (request) => {
          forwarded.push({ url: request.url, method: request.method });
          if (request.url === navigation.hostedUrl)
            return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
          if (request.url === entryUrl)
            return new Response(entry, {
              headers: {
                "content-type": "application/javascript",
                "access-control-allow-origin": "*",
              },
            });
          if (locales.includes(request.url)) {
            if (request.url === locales[0])
              await new Promise((resolve) => setTimeout(resolve, 350));
            return Response.json(
              { synthetic: true },
              { headers: { "access-control-allow-origin": "*" } },
            );
          }
          return new Response("Unexpected synthetic request", { status: 500 });
        },
      });
      driver.configure({
        attemptId: "11111111-1111-4111-8111-111111111111",
        manifestHash: hash("synthetic"),
        identity: "greenhouse:fixture:123",
        authorize: async () => {
          authority.push("authorize");
        },
        freeze: async () => {
          authority.push("freeze");
          throw new Error("Synthetic hydration must not submit");
        },
      });
      try {
        await driver.open(navigation.inputUrl, root);
        const snapshot = await driver.snapshot();
        expect(forwarded[0]).toEqual({ url: navigation.hostedUrl, method: "GET" });
        expect(snapshot.url).toBe(navigation.hostedUrl);
        expect(snapshot.submitAction).toBe(target);
        expect(driver.acceptsUrl(navigation.inputUrl)).toBe(true);
        expect(driver.acceptsUrl(navigation.hostedUrl)).toBe(true);
        expect(driver.acceptsUrl(navigation.hostedUrl.replace("/jobs/123", "/jobs/124"))).toBe(
          false,
        );
        expect(driver.acceptsUrl(navigation.hostedUrl.replace("/fixture/", "/other-board/"))).toBe(
          false,
        );
        expect(snapshot.text).toContain("Hydrated; unpinned resources blocked");
        const country = snapshot.fields.find((field) => field.name === "country");
        expect(country).toMatchObject({ required: true, type: "select", value: "" });
        expect(country?.options).toContain("United States +1");
        expect(snapshot.fields.every((field) => field.value === "")).toBe(true);
        for (const url of locales)
          expect(forwarded.filter((request) => request.url === url)).toHaveLength(1);
        for (const url of denied)
          expect(forwarded.some((request) => request.url === url)).toBe(false);
        expect(
          forwarded.every(
            (request) =>
              request.method === "GET" &&
              [navigation.hostedUrl, entryUrl, ...locales].includes(request.url),
          ),
        ).toBe(true);
        expect(authority).toEqual([]);
        expect(driver.submissionEvidence()).toBeUndefined();
      } finally {
        await driver.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 15000);
  }
  test("identity requires the exact board and posting on an HTTPS Greenhouse host", () => {
    expect(isGreenhousePosting(pageUrl, "greenhouse:fixture:123")).toBe(true);
    expect(isGreenhousePosting(pageUrl, "greenhouse:fixture:124")).toBe(false);
    expect(
      isGreenhousePosting(
        pageUrl.replace("greenhouse.io", "greenhouse.io.evil.test"),
        "greenhouse:fixture:123",
      ),
    ).toBe(false);
  });
  test("initial same-posting HTTP redirect is held without following the destination", async () => {
    const f = await fixture({ redirectInitial: true });
    try {
      let error: unknown;
      try {
        await f.prepare();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(f.forwarded).toEqual([{ url: pageUrl, method: "GET" }]);
      expect(f.events).not.toContain("FROZEN");
      expect(f.driver.confirmed()).toBe(false);
      expect(f.driver.submissionEvidence()).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 25000);
  test("staged hash-bound upload and final POST follow durable freeze; public confirmation alone is insufficient", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      expect(f.stagedUploads).toEqual([
        {
          url: "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/",
          sha256: hash(documentBytes),
          name: "synthetic.pdf",
        },
      ]);
      expect(f.driver.confirmed()).toBe(false);
      await f.driver.submit();
      expect(f.driver.confirmed()).toBe(true);
      expect(f.events.filter((e) => e === "POST /fixture/jobs/123")).toHaveLength(1);
      expect(f.events.indexOf("FROZEN")).toBeLessThan(f.events.indexOf("POST /fixture/jobs/123"));
      expect(f.events.some((e) => e.includes("address/validate"))).toBe(false);
      expect(f.driver.submissionEvidence()?.requestBodyHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await f.close();
    }
  }, 30000);
  test("eager cached built-in presign succeeds before inspection while unknown queries and unapproved uploads stay blocked", async () => {
    const f = await fixture({ eagerPresign: true });
    try {
      await f.open();
      expect(await f.prefetchResult()).toEqual({ ready: true, denied: [true, true, true, true] });
      expect(f.forwarded.filter((request) => request.url === f.eagerPresignUrl)).toEqual([
        { url: f.eagerPresignUrl, method: "GET" },
      ]);
      for (const url of f.deniedPresignUrls)
        expect(f.forwarded.some((request) => request.url === url)).toBe(false);
      expect(f.forwarded.every((request) => request.method === "GET")).toBe(true);
      expect(f.stagedUploads).toEqual([]);

      const snapshot = await f.driver.snapshot();
      const resume = snapshot.fields.find((field) => field.name === "resume");
      if (!resume) throw new Error("Synthetic resume control missing");
      await f.driver.upload(resume, "synthetic.pdf", documentBytes);
      expect(f.stagedUploads).toEqual([
        {
          url: "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/",
          sha256: hash(documentBytes),
          name: "synthetic.pdf",
        },
      ]);
      expect(
        f.events.filter((event) => event === "GET /uncacheable_attributes/presigned_fields"),
      ).toHaveLength(1);
      expect(f.events.filter((event) => event === "POST /")).toHaveLength(1);
      expect(f.events).not.toContain("FROZEN");
      expect(f.events).not.toContain("POST /fixture/jobs/123");
      expect(f.driver.submissionEvidence()).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 15000);
  test("verified staged upload completes a progress-gated renderer before reporting a ready file", async () => {
    const f = await fixture({ progressRequired: true });
    try {
      await f.prepare();
      const snapshot = await f.driver.snapshot();
      expect(snapshot.fields.find((field) => field.name === "resume")?.fileHashes).toEqual([
        hash(documentBytes),
      ]);
      await f.driver.submit();
      expect(f.driver.confirmed()).toBe(true);
      expect(f.events.filter((event) => event === "POST /")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30000);
  test("failed staging cannot complete the progress-gated file display or submit", async () => {
    const f = await fixture({ progressRequired: true, uploadFailure: true });
    try {
      await f.open();
      const snapshot = await f.driver.snapshot();
      const field = snapshot.fields.find((item) => item.name === "resume");
      if (!field) throw new Error("Synthetic resume field missing");
      let failure: unknown;
      try {
        await f.driver.upload(field, "synthetic.pdf", documentBytes);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      const page = (f.driver as unknown as { page: Page }).page;
      expect(await page.locator(".file-upload__filename").count()).toBe(0);
      expect(f.events).not.toContain("FROZEN");
      expect(f.events).not.toContain("POST /fixture/jobs/123");
    } finally {
      await f.close();
    }
  }, 30000);
  test("explicit signed-storage OPTIONS probe exercises the handler before an exact XHR upload", async () => {
    // Playwright may handle Chromium's automatic preflight without exposing a route.
    const f = await fixture({ probePreflight: true });
    try {
      await f.prepare();
      expect(f.events.filter((event) => event === "OPTIONS /")).toHaveLength(1);
      expect(f.events.filter((event) => event === "POST /")).toHaveLength(1);
      expect(f.events.indexOf("OPTIONS /")).toBeLessThan(f.events.indexOf("POST /"));
      expect(f.stagedUploads).toEqual([
        {
          url: "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/",
          sha256: hash(documentBytes),
          name: "synthetic.pdf",
        },
      ]);
      expect(f.events).not.toContain("FROZEN");
      expect(f.events).not.toContain("POST /fixture/jobs/123");
    } finally {
      await f.close();
    }
  }, 15000);
  test("tampered request bytes never reach the application endpoint", async () => {
    const f = await fixture({ mode: "tamper" });
    try {
      await f.prepare();
      let error: unknown;
      try {
        await f.driver.submit();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(f.events.filter((e) => e === "POST /fixture/jobs/123")).toHaveLength(0);
      expect(f.driver.confirmed()).toBe(false);
    } finally {
      await f.close();
    }
  }, 30000);
  test("freeze rejection stops the final POST even after UI submit", async () => {
    const f = await fixture({ revoke: true });
    try {
      await f.prepare();
      let error: unknown;
      try {
        await f.driver.submit();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(f.events.filter((e) => e === "POST /fixture/jobs/123")).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 30000);
  test("post-submit challenge retains response evidence and never automatically replays", async () => {
    const f = await fixture({ mode: "challenge" });
    try {
      await f.prepare();
      await f.driver.submit();
      expect(f.driver.confirmed()).toBe(false);
      expect(f.driver.submissionEvidence()?.responseStatus).toBe(422);
      let error: unknown;
      try {
        await f.driver.submit();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(f.events.filter((e) => e === "POST /fixture/jobs/123")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30000);
  test("lost final response cannot replay an application", async () => {
    const f = await fixture({ mode: "lost" });
    try {
      await f.prepare();
      let first: unknown;
      try {
        await f.driver.submit();
      } catch (error) {
        first = error;
      }
      expect(first).toBeDefined();
      expect(f.driver.confirmed()).toBe(false);
      let second: unknown;
      try {
        await f.driver.submit();
      } catch (error) {
        second = error;
      }
      expect(second).toBeDefined();
      expect(f.events.filter((event) => event === "POST /fixture/jobs/123")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30000);
  test("presign prefetch is blocked after a final request crosses the submit boundary", async () => {
    const f = await fixture({ mode: "challenge", eagerPresign: true });
    try {
      await f.prepare();
      await f.driver.submit();
      const before = f.forwarded.filter((request) => request.url === f.eagerPresignUrl).length;
      const page = (f.driver as unknown as { page: Page }).page;
      const denied = await page.evaluate(
        (url) =>
          fetch(url).then(
            () => false,
            () => true,
          ),
        f.eagerPresignUrl,
      );
      expect(denied).toBe(true);
      expect(f.forwarded.filter((request) => request.url === f.eagerPresignUrl)).toHaveLength(
        before,
      );
      expect(f.events.filter((event) => event === "POST /fixture/jobs/123")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 30000);
  test("final POST redirect stays uncertain after one freeze and cannot follow or replay", async () => {
    const f = await fixture({ mode: "redirect" });
    try {
      await f.prepare();
      let first: unknown;
      try {
        await f.driver.submit();
      } catch (error) {
        first = error;
      }
      expect(first).toBeDefined();
      expect(f.driver.confirmed()).toBe(false);
      expect(f.driver.submissionEvidence()).toBeUndefined();
      let second: unknown;
      try {
        await f.driver.submit();
      } catch (error) {
        second = error;
      }
      expect(second).toBeDefined();
      expect(f.events.filter((event) => event === "FROZEN")).toHaveLength(1);
      expect(f.events.filter((event) => event === "POST /fixture/jobs/123")).toHaveLength(1);
      expect(f.events.indexOf("FROZEN")).toBeLessThan(f.events.indexOf("POST /fixture/jobs/123"));
      expect(f.forwarded.some((request) => request.url === `${pageUrl}/confirmation`)).toBe(false);
    } finally {
      await f.close();
    }
  }, 15000);
  test("reopening a prepared session discards old upload evidence before a stale-reference submit", async () => {
    const f = await fixture({ staleUploadReference: true });
    try {
      await f.prepare();
      expect(f.stagedUploads).toHaveLength(1);
      await f.driver.close();
      await f.open();
      const snapshot = await f.driver.snapshot();
      expect(snapshot.fields.every((field) => field.value === "")).toBe(true);
      expect(snapshot.fields.find((field) => field.name === "resume")?.fileHashes).toEqual([]);
      for (const [name, value] of [
        ["first_name", "Synthetic"],
        ["last_name", "Applicant"],
        ["email", "synthetic@example.test"],
      ]) {
        const field = snapshot.fields.find((candidate) => candidate.name === name);
        if (!field) throw new Error("Synthetic field missing after reopen");
        await f.driver.fill(field, value!);
      }
      let error: unknown;
      try {
        await f.driver.submit();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(f.stagedUploads).toHaveLength(1);
      expect(f.events).not.toContain("FROZEN");
      expect(f.events).not.toContain("POST /fixture/jobs/123");
      expect(f.driver.confirmed()).toBe(false);
      expect(f.driver.submissionEvidence()).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 15000);
  test("a sent request prevents reopening even after the browser is closed", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      await f.driver.submit();
      expect(f.driver.confirmed()).toBe(true);
      const forwardedBeforeClose = [...f.forwarded];
      await f.driver.close();
      let error: unknown;
      try {
        await f.open();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(f.forwarded).toEqual(forwardedBeforeClose);
      expect(f.events.filter((event) => event === "FROZEN")).toHaveLength(1);
      expect(f.events.filter((event) => event === "POST /fixture/jobs/123")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 15000);
});
