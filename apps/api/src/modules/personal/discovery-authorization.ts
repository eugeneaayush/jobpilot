import { personalSourceIdentity } from "@jobpilot/contracts/personal-source";
import { conflict } from "@/common/errors";
import type { Prisma } from "@/generated/prisma/client";
import { schedulerPolicy } from "./campaign-policy";
import { objectValue, personalConfiguration } from "./runtime";

export async function verifyDiscoveryAuthorization(
  prisma: Pick<Prisma.TransactionClient, "campaign">,
  userId: string,
  input: {
    campaignId?: string;
    runId?: string;
    query?: string;
    maxPages?: number;
    pageSize?: number;
  },
  sourceIdentity?: string,
) {
  if (!input.campaignId && !input.runId) return;
  if (!input.campaignId || !input.runId) throw conflict("Campaign and run must both be supplied");
  const campaign = await prisma.campaign.findFirst({
    where: { campaignId: input.campaignId, userId },
  });
  if (!campaign) throw conflict("Scheduled discovery campaign is unavailable");
  const policy = schedulerPolicy(campaign.config);
  if (
    campaign.status !== "in_progress" ||
    !policy.enabled ||
    policy.authorization?.runId !== input.runId
  )
    throw conflict("Scheduled discovery campaign stopped or authorization changed");
  if (
    sourceIdentity &&
    ![
      ...policy.sources.boardTokens.map((token) => `greenhouse:${token}`),
      ...(policy.sources.instances ?? []).map(personalSourceIdentity),
    ].includes(sourceIdentity)
  )
    throw conflict("Discovery source is outside the campaign scope");
  if (input.query) {
    const configured = objectValue((await personalConfiguration(userId)).pilotDiscovery).queries;
    if (
      !Array.isArray(configured) ||
      !configured.some((item) => {
        const query = objectValue(item);
        return (
          query.campaignId === input.campaignId &&
          query.query === input.query &&
          (input.maxPages ?? 3) <= Number(query.maxPages ?? 3) &&
          (input.pageSize ?? 20) <= Number(query.pageSize ?? 20)
        );
      })
    )
      throw conflict("Scheduled search query is not configured for this campaign");
  }
}
