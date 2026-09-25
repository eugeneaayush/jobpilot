/// <reference lib="dom" />
import type { Browser, Route } from "@playwright/test";
import { chromium } from "@playwright/test";
import {
  finishGreenhouseUploadProgress,
  installGreenhouseUploadProgress,
} from "../../../../../plugin/scripts/personal-browser/greenhouse-upload";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const uploadUrl = "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/";
const fixtureUrl = "https://synthetic-upload.invalid/";
const byteLength = 21;
interface Probe {
  requests: XMLHttpRequest[];
  completed: number;
  events: { native: boolean; loaded: number; total: number; lengthComputable: boolean }[];
}
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, timeout: 10_000 });
}, 15_000);
afterAll(async () => {
  await browser?.close();
});

async function fixture() {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await installGreenhouseUploadProgress(context);
  const requests: Route[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (request.url() === fixtureUrl)
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic upload</title>",
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET",
          "access-control-allow-headers": "content-type",
        },
      });
    requests.push(route);
  });
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.evaluate(() => {
    (window as unknown as { probe: Probe }).probe = { requests: [], completed: 0, events: [] };
  });
  return {
    page,
    requests,
    async start(url = uploadUrl, method = "POST") {
      await page.evaluate(
        ({ url, method }) => {
          const probe = (window as unknown as { probe: Probe }).probe;
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (event) =>
            probe.events.push({
              native: event instanceof ProgressEvent,
              loaded: event.loaded,
              total: event.total,
              lengthComputable: event.lengthComputable,
            });
          xhr.onloadend = () => {
            probe.completed++;
          };
          xhr.open(method, url);
          probe.requests.push(xhr);
          xhr.send(method === "POST" ? "synthetic-upload-body" : null);
        },
        { url, method },
      );
      const deadline = Date.now() + 3_000;
      while (
        requests.length <
        (await page.evaluate(() => (window as unknown as { probe: Probe }).probe.requests.length))
      ) {
        if (Date.now() >= deadline) throw new Error("Synthetic intercepted request did not arrive");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async respond(index = 0, status = 201) {
      await requests[index]!.fulfill({
        status,
        body: "",
        headers: { "access-control-allow-origin": "*" },
      });
    },
    async settled(count = 1) {
      await page.waitForFunction(
        (count) => (window as unknown as { probe: Probe }).probe.completed === count,
        count,
        { timeout: 3_000 },
      );
    },
    events: () => page.evaluate(() => (window as unknown as { probe: Probe }).probe.events),
    close: () => context.close(),
  };
}

async function rejection(action: () => Promise<unknown>) {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("Greenhouse verified upload progress bridge", () => {
  test("waits for DONE and 2xx then emits the verified native progress event once", async () => {
    const f = await fixture();
    try {
      expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(false);
      await f.start();
      expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(false);
      await f.respond();
      await f.settled();
      const before = await f.events();
      expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(true);
      expect((await f.events()).slice(before.length)).toEqual([
        { native: true, loaded: 21, total: 21, lengthComputable: true },
      ]);
      expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(false);
      expect(await f.events()).toHaveLength(before.length + 1);
    } finally {
      await f.close();
    }
  }, 15_000);

  test("non-2xx completion never receives a completion progress event", async () => {
    const f = await fixture();
    try {
      await f.start();
      await f.respond(0, 403);
      await f.settled();
      const before = await f.events();
      expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(false);
      expect(await f.events()).toEqual(before);
    } finally {
      await f.close();
    }
  }, 15_000);

  for (const failure of ["abort", "error"] as const) {
    test(`${failure} never receives a completion progress event`, async () => {
      const f = await fixture();
      try {
        await f.start();
        if (failure === "abort")
          await f.page.evaluate(() =>
            (window as unknown as { probe: Probe }).probe.requests[0]!.abort(),
          );
        else await f.requests[0]!.abort("failed");
        await f.settled();
        const before = await f.events();
        expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(false);
        expect(await f.events()).toEqual(before);
      } finally {
        await f.close();
      }
    }, 15_000);
  }

  test("rejects two tracked uploads without consuming either completion", async () => {
    const f = await fixture();
    try {
      await f.start();
      await f.start();
      expect(
        (await rejection(() => finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)))
          .message,
      ).toContain("Ambiguous");
      await f.respond(0);
      await f.respond(1);
      await f.settled(2);
      const before = await f.events();
      expect(
        (await rejection(() => finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)))
          .message,
      ).toContain("Ambiguous");
      expect(await f.events()).toEqual(before);
    } finally {
      await f.close();
    }
  }, 15_000);

  test("invalid URLs and byte lengths cannot consume a completed upload", async () => {
    const f = await fixture();
    try {
      await f.start();
      await f.respond();
      await f.settled();
      for (const url of [
        "not-a-url",
        uploadUrl.replace("https:", "http:"),
        `${uploadUrl}?x=1`,
        `${uploadUrl}#fragment`,
        uploadUrl.replace("https://", "https://name:secret@"),
        `${uploadUrl}other`,
        "https://synthetic-unknown.invalid/",
      ])
        expect(
          (await rejection(() => finishGreenhouseUploadProgress(f.page, url, byteLength))).message,
        ).toContain("Invalid");
      for (const bytes of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ])
        expect(
          (await rejection(() => finishGreenhouseUploadProgress(f.page, uploadUrl, bytes))).message,
        ).toContain("Invalid");
      expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(true);
    } finally {
      await f.close();
    }
  }, 15_000);

  for (const request of [
    { method: "GET", url: uploadUrl },
    { method: "POST", url: `${uploadUrl}?unapproved=true` },
  ]) {
    test(`ignores an unapproved ${request.method} request ${new URL(request.url).search || "without a body"}`, async () => {
      const f = await fixture();
      try {
        await f.start(request.url, request.method);
        await f.respond();
        await f.settled();
        const before = await f.events();
        expect(await finishGreenhouseUploadProgress(f.page, uploadUrl, byteLength)).toBe(false);
        expect(await f.events()).toEqual(before);
      } finally {
        await f.close();
      }
    }, 15_000);
  }
});
