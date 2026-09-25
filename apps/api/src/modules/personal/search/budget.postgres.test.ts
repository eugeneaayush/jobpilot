import type { PersonalSearchReceipt } from "@jobpilot/contracts/personal-search";
import type { PersonalTestDatabase } from "../persistence-test-fixtures";
import { finishPersonalSearchSpend, reservePersonalSpend } from "./budget";
import { searchNow } from "./fakes";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.PERSONAL_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("personal search spend PostgreSQL concurrency", () => {
  let db: PersonalTestDatabase;
  beforeAll(async () => {
    const { createPersonalTestDatabase } = await import("../persistence-test-fixtures");
    db = await createPersonalTestDatabase(testUrl!);
  }, 30000);
  afterAll(async () => {
    if (db) await db.dispose();
  });
  async function user(monthlyBudgetCents = 20000, searchBudgetCents = 1) {
    const owner = await db.prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test`, username: crypto.randomUUID() },
    });
    await db.prisma.personalPolicy.create({
      data: {
        userId: owner.id,
        monthlyBudgetCents,
        searchBudgetCents,
        timezone: "America/New_York",
      },
    });
    return owner.id;
  }
  const request = {
    provider: "brave",
    category: "search" as const,
    amountMicrousd: 5000,
    requestHash: "a".repeat(64),
  };
  test("concurrent workers cannot over-reserve the search sub-budget", async () => {
    const owner = await user();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        reservePersonalSpend(db.prisma, owner, request, searchNow()),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(
      results.filter((result) => !result.ok && result.reason === "budget_exhausted"),
    ).toHaveLength(10);
    const [sum] = await db.prisma.$queryRaw<
      { total: bigint; count: bigint }[]
    >`SELECT SUM(amount_microusd)::bigint AS total, COUNT(*)::bigint AS count FROM personal_spend_reservations WHERE user_id = ${owner}`;
    expect(Number(sum?.total)).toBe(10000);
    expect(Number(sum?.count)).toBe(2);
  });
  test("tailoring and other providers consume the same global cap", async () => {
    const owner = await user(1, 1);
    expect(
      (
        await reservePersonalSpend(
          db.prisma,
          owner,
          { ...request, provider: "synthetic-model", category: "tailoring", amountMicrousd: 7000 },
          searchNow(),
        )
      ).ok,
    ).toBe(true);
    const search = await reservePersonalSpend(db.prisma, owner, request, searchNow());
    expect(search.ok).toBe(false);
    expect(search.budget.monthlyReservedMicrousd).toBe(7000);
    expect(search.budget.searchReservedMicrousd).toBe(0);
  });
  test("uncertain reservations remain charged and final receipt is single-use", async () => {
    const owner = await user();
    const reservation = await reservePersonalSpend(
      db.prisma,
      owner,
      { ...request, amountMicrousd: 10000 },
      searchNow(),
    );
    if (!reservation.ok) throw new Error("Synthetic reservation unexpectedly denied");
    const receipt: PersonalSearchReceipt = {
      reservationId: reservation.id,
      status: "uncertain",
      amountMicrousd: 10000,
      page: 0,
      sourceUrlHash: request.requestHash,
      responseHash: null,
      httpStatus: null,
      observedCount: 0,
      nextEligibleAt: null,
      reason: "request_timeout_or_cancelled",
    };
    await finishPersonalSearchSpend(db.prisma, owner, receipt, {}, searchNow());
    await expect(
      finishPersonalSearchSpend(db.prisma, owner, receipt, {}, searchNow()),
    ).rejects.toThrow("persisted");
    const second = await reservePersonalSpend(db.prisma, owner, request, searchNow());
    expect(second.ok).toBe(false);
    expect(second.budget.searchReservedMicrousd).toBe(10000);
  });
  test("provider cooldown is durable across queries and does not reserve another charge", async () => {
    const owner = await user(20000, 5000);
    const reservation = await reservePersonalSpend(db.prisma, owner, request, searchNow());
    if (!reservation.ok) throw new Error("Synthetic reservation unexpectedly denied");
    const nextEligibleAt = new Date(searchNow().getTime() + 90000);
    await finishPersonalSearchSpend(
      db.prisma,
      owner,
      {
        reservationId: reservation.id,
        status: "blocked",
        amountMicrousd: 5000,
        page: 0,
        sourceUrlHash: request.requestHash,
        responseHash: null,
        httpStatus: 429,
        observedCount: 0,
        nextEligibleAt,
        reason: "http_429",
      },
      {},
      searchNow(),
    );
    const deferred = await reservePersonalSpend(
      db.prisma,
      owner,
      { ...request, requestHash: "b".repeat(64) },
      searchNow(),
    );
    expect(deferred).toMatchObject({ ok: false, reason: "cooldown", nextEligibleAt });
    expect(deferred.budget.searchReservedMicrousd).toBe(5000);
    expect(
      (
        await reservePersonalSpend(
          db.prisma,
          owner,
          request,
          new Date(nextEligibleAt.getTime() + 1),
        )
      ).ok,
    ).toBe(true);
  });
  test("the next policy month resets capacity without deleting prior charges", async () => {
    const owner = await user();
    const first = await reservePersonalSpend(
      db.prisma,
      owner,
      { ...request, amountMicrousd: 10000 },
      new Date("2026-10-01T02:00:00Z"),
    );
    expect(first.budget.month).toBe("2026-09");
    expect(
      (await reservePersonalSpend(db.prisma, owner, request, new Date("2026-10-01T03:59:59Z"))).ok,
    ).toBe(false);
    const next = await reservePersonalSpend(
      db.prisma,
      owner,
      request,
      new Date("2026-10-01T04:00:00Z"),
    );
    expect(next.ok).toBe(true);
    expect(next.budget.month).toBe("2026-10");
    const [count] = await db.prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT COUNT(*)::bigint AS count FROM personal_spend_reservations WHERE user_id = ${owner}`;
    expect(Number(count?.count)).toBe(2);
  });
});
