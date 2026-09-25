/** Synthetic components only: every API request is intercepted with fake records. */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base } from "@playwright/test";
import { API } from "./fakes";
import { observe } from "./network";

const WEB = path.resolve(__dirname, "../../apps/web");
export let harnessOrigin: string;

export const test = base.extend<Record<never, never>, { harness: string }>({
  harness: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring fixture dependencies.
    async ({}, use) => {
      const outDir = await mkdtemp(path.join(tmpdir(), "personal-ui-"));
      const bundlePath = path.join(outDir, "bundle.js");

      const build = spawnSync(
        "bun",
        [
          "build",
          "src/components/features/personal/harness-entry.tsx",
          "--outfile",
          bundlePath,
          "--target",
          "browser",
          "--format",
          "esm",
        ],
        { cwd: WEB, encoding: "utf8" },
      );
      if (build.status !== 0) {
        throw new Error(`harness bundle failed:\n${build.stdout}\n${build.stderr}`);
      }

      // The bundle reads NEXT_PUBLIC_API_URL off process.env; shim `process` before it loads.
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>personal harness</title></head>
<body>
<script>window.process = { env: { NODE_ENV: "test", NEXT_PUBLIC_API_URL: "${API}" } };</script>
<div id="root"></div>
<script type="module" src="/bundle.js"></script>
</body></html>`;
      const htmlPath = path.join(outDir, "index.html");
      await writeFile(htmlPath, html);

      const server = createServer(async (req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(await readFile(htmlPath));
          return;
        }
        if (req.url === "/bundle.js") {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(await readFile(bundlePath));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("no harness port");
      }
      harnessOrigin = `http://127.0.0.1:${address.port}`;
      try {
        await use(harnessOrigin);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(outDir, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  page: async ({ page, harness }, use) => {
    observe(page);
    await page.goto(harness);
    await use(page);
  },
});
