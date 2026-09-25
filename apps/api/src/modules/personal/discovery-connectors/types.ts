import type { DiscoveredPosting, DiscoveryOptions, DiscoveryResult } from "../discovery";

export interface ConnectorPosting extends Omit<DiscoveredPosting, "source"> {
  source: "lever" | "ashby" | "cbs";
  sourceRegion: "global" | "eu" | null;
  employerId: string | null;
  employerNameSource: "configured" | "board_token" | "export";
  locations: string[];
  publishedAt: string | null;
  publishedAtMeaning: "last_published" | "export_reported" | null;
  provenance: { responseHash: string; row: number; line: number | null };
}

export interface ConnectorResult extends Omit<DiscoveryResult, "postings" | "health"> {
  postings: ConnectorPosting[];
  health: DiscoveryResult["health"] & {
    nextEligibleAt: string | null;
    lastFailure: "blocked" | "failed" | null;
    receipts: {
      url: string;
      checkedAt: string;
      httpStatus: number | null;
      contentHash: string | null;
      bytes: number | null;
    }[];
  };
  coverage: {
    scope: "public_board" | "provided_export";
    observedTotal: number;
    excludedUnlisted: number;
    exhausted: boolean;
    empty: boolean | null;
  };
}

export interface ConnectorOptions extends DiscoveryOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}
