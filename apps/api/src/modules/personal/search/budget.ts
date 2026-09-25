import { randomUUID } from "node:crypto";
import {
  PERSONAL_SPEND_CATEGORIES,
  type PersonalSearchBudget,
  type PersonalSearchReceipt,
} from "@jobpilot/contracts/personal-search";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

type SpendCategory = (typeof PERSONAL_SPEND_CATEGORIES)[number];
export interface SpendRequest {
  provider: string;
  category: SpendCategory;
  amountMicrousd: number;
  requestHash: string;
}
export type SpendReservation =
  | { ok: true; id: string; budget: PersonalSearchBudget }
  | {
      ok: false;
      reason: "budget_exhausted" | "cooldown";
      nextEligibleAt: Date;
      budget: PersonalSearchBudget;
    };

export function policyMonthWindow(timezone: string, now: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  });
  const key = (date: Date) => {
    const parts = formatter.formatToParts(date);
    return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
  };
  const month = key(now);
  const [year, number] = month.split("-").map(Number);
  const boundary = (targetYear: number, targetMonth: number) => {
    const guess = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
    const target = guess.toISOString().slice(0, 7);
    let lower = guess.getTime() - 36 * 60 * 60 * 1000;
    let upper = guess.getTime() + 36 * 60 * 60 * 1000;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (key(new Date(middle)) < target) lower = middle + 1;
      else upper = middle;
    }
    return new Date(lower);
  };
  return { month, start: boundary(year, number), end: boundary(year, number + 1) };
}

export async function reservePersonalSpend(
  prisma: PrismaClient,
  userId: string,
  request: SpendRequest,
  now = new Date(),
  authorize?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<SpendReservation> {
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(request.provider) ||
    !PERSONAL_SPEND_CATEGORIES.includes(request.category) ||
    !Number.isSafeInteger(request.amountMicrousd) ||
    request.amountMicrousd <= 0 ||
    request.amountMicrousd > 200_000_000 ||
    !/^[a-f0-9]{64}$/.test(request.requestHash)
  )
    throw new Error("Invalid server spend reservation");
  return prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!users.length) throw new Error("Search account not found");
    await authorize?.(tx);
    const policy = await tx.personalPolicy.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    if (
      ![policy.monthlyBudgetCents, policy.searchBudgetCents].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error("Invalid personal budget policy");
    const window = policyMonthWindow(policy.timezone, now);
    // Sum timestamps in the current authoritative timezone, so a timezone edit cannot erase prior spend.
    const [totals] = await tx.$queryRaw<{ total: bigint; search: bigint }[]>`
      SELECT COALESCE(SUM(amount_microusd), 0)::bigint AS total,
        COALESCE(SUM(amount_microusd) FILTER (WHERE category = 'search'), 0)::bigint AS search
      FROM personal_spend_reservations WHERE user_id = ${userId} AND reserved_at >= ${window.start} AND reserved_at < ${window.end}`;
    const budget: PersonalSearchBudget = {
      month: window.month,
      timezone: policy.timezone,
      monthlyLimitMicrousd: Math.min(20_000, policy.monthlyBudgetCents) * 10_000,
      searchLimitMicrousd: Math.min(5_000, policy.searchBudgetCents) * 10_000,
      monthlyReservedMicrousd: Number(totals?.total ?? 0),
      searchReservedMicrousd: Number(totals?.search ?? 0),
      tracking: "local_reservations",
      actualProviderBillKnown: false,
    };
    const [cooldown] = await tx.$queryRaw<{ until: Date | null }[]>`
      SELECT MAX(next_eligible_at) AS until FROM personal_spend_reservations
      WHERE user_id = ${userId} AND provider = ${request.provider} AND next_eligible_at > ${now}`;
    if (cooldown?.until)
      return { ok: false, reason: "cooldown", nextEligibleAt: cooldown.until, budget };
    if (
      budget.monthlyReservedMicrousd + request.amountMicrousd > budget.monthlyLimitMicrousd ||
      (request.category === "search" &&
        budget.searchReservedMicrousd + request.amountMicrousd > budget.searchLimitMicrousd)
    )
      return { ok: false, reason: "budget_exhausted", nextEligibleAt: window.end, budget };
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO personal_spend_reservations (id, user_id, provider, category, amount_microusd, policy_month, policy_timezone, request_hash, reserved_at)
      VALUES (${id}, ${userId}, ${request.provider}, CAST(${request.category} AS personal_spend_category), ${request.amountMicrousd}, ${window.month}, ${policy.timezone}, ${request.requestHash}, ${now})`;
    budget.monthlyReservedMicrousd += request.amountMicrousd;
    if (request.category === "search") budget.searchReservedMicrousd += request.amountMicrousd;
    return { ok: true, id, budget };
  });
}

export async function finishPersonalSearchSpend(
  prisma: PrismaClient,
  userId: string,
  receipt: PersonalSearchReceipt,
  metadata: Record<string, unknown>,
  now = new Date(),
) {
  if (receipt.status === "reserved") throw new Error("A completed receipt needs a terminal status");
  const saved = await prisma.$executeRaw`
    UPDATE personal_spend_reservations SET status = CAST(${receipt.status} AS personal_spend_status),
      completed_at = ${now}, next_eligible_at = ${receipt.nextEligibleAt}, receipt = CAST(${JSON.stringify({ ...metadata, ...receipt })} AS jsonb)
    WHERE id = ${receipt.reservationId} AND user_id = ${userId} AND status = 'reserved'
      AND provider = 'brave' AND category = 'search'
      AND amount_microusd = ${receipt.amountMicrousd} AND request_hash = ${receipt.sourceUrlHash}`;
  if (saved !== 1)
    throw new Error("Search receipt could not be persisted; reservation remains charged");
}
