import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function renderReviewPages(
  bytes: Uint8Array,
  options: { directory: string; pdfHash: string; maxPages: 1 | 2; signal?: AbortSignal },
) {
  if (bytes.length > 16_000_000 || sha256(bytes) !== options.pdfHash)
    throw new Error("Frozen PDF integrity or size check failed");
  const command = Bun.which("pdftoppm");
  const textCommand = Bun.which("pdftotext");
  if (!command || !textCommand) throw new Error("Local Poppler rendering dependencies are missing");
  const pageCount = [
    ...Buffer.from(bytes)
      .toString("latin1")
      .matchAll(/\/Type\s*\/Page\b/g),
  ].length;
  if (pageCount < 1 || pageCount > options.maxPages) throw new Error("PDF exceeds page budget");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  const pdfPath = path.join(options.directory, "document.pdf");
  await writeFile(pdfPath, bytes, { mode: 0o600, flag: "wx" });
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    const cancel = () => child.kill("SIGKILL");
    const timer = setTimeout(cancel, 30_000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      if ((await child.exited) !== 0 || options.signal?.aborted)
        throw new Error("Local PDF rendering failed or was cancelled");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  };
  const prefix = path.join(options.directory, "page");
  await run([command, "-png", "-r", "110", "-f", "1", "-l", String(pageCount), pdfPath, prefix]);
  const textPath = path.join(options.directory, "text.txt");
  await run([textCommand, "-layout", pdfPath, textPath]);
  await chmod(textPath, 0o600);
  const textContext = await readFile(textPath, "utf8");
  if (textContext.trim().length < 100 || textContext.length > 100_000)
    throw new Error("PDF has insufficient or excessive extractable text");
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const pngPath = `${prefix}-${pageNumber}.png`;
    await chmod(pngPath, 0o600);
    const png = await readFile(pngPath);
    if (png.length > 10_000_000) throw new Error("Rendered page exceeds the review bound");
    pages.push({ pageNumber, png, sha256: sha256(png) });
  }
  return { pdfHash: options.pdfHash, maxPages: options.maxPages, pageCount, textContext, pages };
}
