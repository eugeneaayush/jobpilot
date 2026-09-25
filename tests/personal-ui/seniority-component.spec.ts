/**
 * Isolated synthetic harness for the seniority-assessment component only. The shared
 * personal harness mounts the dashboard, so this spec builds a private page: a temp entry
 * importing the component by absolute path, bundled by Bun, served from an ephemeral local
 * server. All inputs are synthetic; nothing touches the API, private runtime, or employers.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const WEB = path.resolve(__dirname, "../../apps/web");
const COMPONENT = path.resolve(WEB, "src/components/features/personal/seniority-assessment.tsx");

interface Case {
  classification:
    | "graduate_recruiting"
    | "experienced_professional"
    | "undergraduate_entry"
    | "unresolved";
  reasons: string[];
  evidence: { field: "title" | "description"; quote: string }[];
}

test.setTimeout(60_000);

let server: ReturnType<typeof createServer>;
let origin: string;

test.beforeAll(async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "seniority-ui-"));
  const bundlePath = path.join(outDir, "bundle.js");

  const entry = `import { createRoot } from "react-dom/client";
import { SeniorityAssessment } from "./seniority-assessment";
import { ThemeProvider } from "@/providers/theme-provider";
const cases = window.SENIORITY_CASES;
const root = document.getElementById("root");
if (root) {
  for (const [i, c] of cases.entries()) {
    const el = document.createElement("section");
    el.id = "case-" + i;
    root.appendChild(el);
    createRoot(el).render(
      <ThemeProvider>
        <SeniorityAssessment {...c} />
      </ThemeProvider>,
    );
  }
}`;
  // Node-module resolution walks up from the entry, so the temp entry must sit next to the
  // component for the build to resolve react-dom. It exists only for the build and is
  // removed immediately — never a committed file.
  const entryPath = path.join(path.dirname(COMPONENT), ".seniority-harness-entry.tmp.tsx");
  await writeFile(entryPath, entry);
  try {
    const build = spawnSync(
      "bun",
      ["build", entryPath, "--outfile", bundlePath, "--target", "browser", "--format", "esm"],
      { cwd: WEB, encoding: "utf8" },
    );
    if (build.status !== 0) {
      throw new Error(`seniority harness bundle failed:\n${build.stdout}\n${build.stderr}`);
    }
  } finally {
    await rm(entryPath, { force: true });
  }

  const html = (cases: Case[]) => `<!doctype html>
<html><head><meta charset="utf-8"><title>seniority harness</title></head>
<body>
<!-- Same env shim the shared personal harness uses: bundled MUI reads process.env. -->
<script>window.process = { env: { NODE_ENV: "test" } };</script>
<script>window.SENIORITY_CASES = ${JSON.stringify(cases)};</script>
<div id="root"></div>
<script type="module" src="/bundle.js"></script>
</body></html>`;

  server = createServer(async (req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?cases=")) {
      const cases = JSON.parse(
        decodeURIComponent(new URL(req.url, "http://x").searchParams.get("cases") ?? "[]"),
      ) as Case[];
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(cases));
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
  if (address === null || typeof address === "string") throw new Error("no harness port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const CASES: Case[] = [
  {
    classification: "graduate_recruiting",
    reasons: ["MBA internship program", "current enrollment stated"],
    evidence: [
      { field: "title", quote: "Summer Associate, 2027 MBA Program" },
      { field: "description", quote: "Candidates must be enrolled in an MBA program" },
    ],
  },
  {
    classification: "experienced_professional",
    reasons: ["8+ years required"],
    evidence: [{ field: "description", quote: "Requires 8+ years of pricing experience" }],
  },
  {
    classification: "undergraduate_entry",
    reasons: ["High-school entry warehouse role"],
    evidence: [],
  },
  {
    classification: "unresolved",
    reasons: ["No graduate-level signal in posting"],
    evidence: [{ field: "title", quote: "Analyst" }],
  },
];

async function loadCases(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${origin}/?cases=${encodeURIComponent(JSON.stringify(CASES))}`);
  await expect(page.locator("#case-0")).toBeVisible();
}

test("accepted classifications state graduate and experienced tracks", async ({ page }) => {
  await loadCases(page);
  const graduate = page.locator("#case-0");
  await expect(graduate.getByText("Accepted — Graduate recruiting")).toBeVisible();
  await expect(graduate.getByText("Graduate recruiting", { exact: true }).first()).toBeVisible();

  const experienced = page.locator("#case-1");
  await expect(experienced.getByText("Accepted — Experienced professional")).toBeVisible();
});

test("undergraduate entry is excluded with the policy stated", async ({ page }) => {
  await loadCases(page);
  const excluded = page.locator("#case-2");
  await expect(excluded.getByText("Excluded — undergraduate entry")).toBeVisible();
  await expect(
    excluded.getByText("This plan does not pursue entry-level undergraduate roles."),
  ).toBeVisible();
  // No quoted evidence renders the honest no-evidence note, never a fabricated signal.
  await expect(excluded.getByText("No source evidence recorded.")).toBeVisible();
});

test("unresolved demands evidence and is never eligible by default", async ({ page }) => {
  await loadCases(page);
  const unresolved = page.locator("#case-3");
  // The chip reads exactly "Needs evidence"; the alert states the full verdict.
  await expect(unresolved.getByText("Needs evidence", { exact: true })).toBeVisible();
  await expect(
    unresolved.getByText("Needs evidence — no affirmative graduate-level evidence yet."),
  ).toBeVisible();
  await expect(unresolved.getByText("Unknown seniority is not eligible.")).toBeVisible();
});

test("reasons and source quotes render verbatim", async ({ page }) => {
  await loadCases(page);
  const graduate = page.locator("#case-0");
  await expect(graduate.getByText("MBA internship program", { exact: true })).toBeVisible();
  await expect(graduate.getByText("“Summer Associate, 2027 MBA Program”")).toBeVisible();
  await expect(graduate.getByText("description", { exact: true }).first()).toBeVisible();
  // Mixed-program policy rationale is always visible.
  await expect(
    graduate.getByText("mixed programs need affirmative graduate-level evidence"),
  ).toBeVisible();
});
