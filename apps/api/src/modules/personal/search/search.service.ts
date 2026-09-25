import type { PersonalSearchInput } from "@jobpilot/contracts/personal-search";
import { singleton } from "tsyringe";
import { PrismaClient } from "@/generated/prisma/client";
import { verifyDiscoveryAuthorization } from "../discovery-authorization";
import { jsonValue, personalConfiguration } from "../runtime";
import { finishPersonalSearchSpend, reservePersonalSpend } from "./budget";
import { runPersonalSearch } from "./search";

@singleton()
export class PersonalSearchService {
  constructor(private readonly prisma: PrismaClient) {}

  async search(userId: string, input: PersonalSearchInput) {
    await verifyDiscoveryAuthorization(this.prisma, userId, input);
    const result = await runPersonalSearch(userId, input, {
      configuration: personalConfiguration,
      reserve: (owner, request, now) =>
        reservePersonalSpend(this.prisma, owner, request, now, (tx) =>
          verifyDiscoveryAuthorization(tx, userId, input),
        ),
      fetch: (async (...args: Parameters<typeof fetch>) => {
        await verifyDiscoveryAuthorization(this.prisma, userId, input);
        return fetch(...args);
      }) as typeof fetch,
      finish: (owner, receipt, metadata, now) =>
        finishPersonalSearchSpend(this.prisma, owner, receipt, metadata, now),
    });
    const statuses = {
      complete: "complete",
      partial: "partial",
      failed: "failed",
      blocked: "blocked",
      missing_setup: "blocked",
      budget_exhausted: "blocked",
      cooldown: "blocked",
    } as const;
    await this.prisma.personalDiscoveryRun.create({
      data: {
        userId,
        source: `brave:${result.queryHash}`,
        status: statuses[result.status],
        details: jsonValue({
          ...result,
          count: result.candidates.length,
          error: result.reasons.join("; ") || null,
        }),
      },
    });
    return result;
  }
}
