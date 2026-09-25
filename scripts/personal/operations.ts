import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiRequest, privateWrite, readConfig, runtimeRoot } from "./common";

export async function operation(command: string, args: string[]): Promise<void> {
  const config = await readConfig();
  const id = args[0];
  const requireId = () => {
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("A record UUID is required");
    return id;
  };
  const inputFile = async (file: string | undefined) => {
    if (!file) throw new Error("Supply a JSON input file path");
    return JSON.parse(await readFile(path.resolve(file), "utf8"));
  };
  let result: unknown;
  if (command === "reassess") result = await apiRequest(config, "/personal/reassess", {});
  else if (command === "discover")
    result = await apiRequest(config, "/personal/discover", await inputFile(id));
  else if (command === "search") {
    if (!args.length)
      throw new Error("Supply a public career-search query; do not include applicant data");
    result = await apiRequest(config, "/personal/search", {
      query: args.join(" "),
      maxPages: 3,
      pageSize: 20,
    });
  } else if (command === "tailor")
    result = await apiRequest(config, `/personal/${requireId()}/tailoring`, {});
  else if (command === "tailor-review")
    result = await apiRequest(
      config,
      `/personal/${requireId()}/tailoring/review`,
      await inputFile(args[1]),
    );
  else if (command === "registry")
    result = await apiRequest(config, `/personal/registry?page=${Number(id ?? 1)}&limit=100`);
  else if (command === "digest") result = await apiRequest(config, "/personal/digest/tick", {});
  else throw new Error("Unknown personal operation");
  const artifact = path.join(
    runtimeRoot,
    "operations",
    `${command}-${Date.now()}-${crypto.randomUUID()}.json`,
  );
  await privateWrite(artifact, result);
  const data = result as Record<string, unknown>;
  console.log(
    JSON.stringify({
      command,
      status: data.status ?? "recorded",
      evaluated: data.evaluated,
      skipped: data.skipped,
      artifact,
      employerSubmission: false,
    }),
  );
}
