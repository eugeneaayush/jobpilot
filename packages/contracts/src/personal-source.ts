export function personalSourceIdentity(source: {
  source: "greenhouse" | "lever" | "ashby" | "cbs";
  boardToken: string;
  region?: "global" | "eu";
}) {
  if (source.source === "lever") return `lever:${source.region ?? "global"}:${source.boardToken}`;
  return `${source.source}:${source.boardToken}`;
}
