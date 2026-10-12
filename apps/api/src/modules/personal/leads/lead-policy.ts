import { isIP } from "node:net";
import { personalLeadConfigurationSchema } from "@jobpilot/contracts/personal-leads";
import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";

export function normalizeLeadUrl(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new Error("Lead URLs must use a public HTTPS host without credentials or custom ports");
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || (key === "ref" && url.searchParams.get(key) === "Simplify"))
      url.searchParams.delete(key);
  return url.href;
}

export function officialLeadDestination(input: string) {
  const url = new URL(normalizeLeadUrl(input));
  const parts = url.pathname.split("/").filter(Boolean);
  let source: "greenhouse" | "lever" | "ashby";
  let region: "global" | "eu" = "global";
  let nativeId: string | undefined;
  if (
    ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) &&
    parts.length === 3 &&
    parts[1] === "jobs" &&
    /^\d+$/.test(parts[2] ?? "")
  ) {
    source = "greenhouse";
    nativeId = parts[2];
  } else if (
    ["jobs.lever.co", "jobs.eu.lever.co"].includes(url.hostname) &&
    (parts.length === 2 || (parts.length === 3 && parts[2] === "apply"))
  ) {
    source = "lever";
    region = url.hostname === "jobs.eu.lever.co" ? "eu" : "global";
    nativeId = parts[1];
  } else if (
    url.hostname === "jobs.ashbyhq.com" &&
    (parts.length === 2 || (parts.length === 3 && parts[2] === "application"))
  ) {
    source = "ashby";
    nativeId = parts[1];
  } else throw new Error("Resolve the lead to a supported official ATS posting first");
  const boardToken = parts[0];
  if (
    !boardToken ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(boardToken) ||
    !nativeId ||
    !/^[a-zA-Z0-9_-]{1,150}$/.test(nativeId)
  )
    throw new Error("Invalid ATS posting identity");
  const configuration = { source, boardToken, ...(source === "lever" ? { region } : {}) };
  const sourceIdentity = personalSourceIdentity(configuration);
  return {
    ...configuration,
    nativeId,
    sourceIdentity,
    identity: `${sourceIdentity}:${nativeId}`,
    url: url.href,
  };
}

export function sourceEnabled(
  configuration: unknown,
  kind: "boards" | "feeds",
  source: string,
): boolean {
  const parsed = personalLeadConfigurationSchema.safeParse(configuration);
  return parsed.success && (parsed.data[kind] as string[]).includes(source);
}

export function requireFullDiscoveryDescriptions(result: {
  status: "complete" | "partial" | "blocked" | "failed";
  postings: { descriptionText: string }[];
  health: { errors: string[] };
}) {
  const rejected = result.postings.filter((posting) => !posting.descriptionText.trim()).length;
  if (rejected) {
    result.postings = result.postings.filter((posting) => posting.descriptionText.trim());
    result.health.errors.push(`${rejected} postings omitted: full description is unavailable`);
    if (result.status === "complete") result.status = "partial";
  }
  return result;
}
