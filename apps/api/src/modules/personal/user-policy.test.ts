import type { Prisma } from "@/generated/prisma/client";
import { employerIdentity, enforceEmployerCap } from "./user-policy";
import { describe, expect, it } from "bun:test";

const userId = "11111111-1111-4111-8111-111111111111";
const canonicalEmployer = "domain:synthetic.example.com";
const evidence = {
  schemaVersion: 1,
  verification: "owner_attested",
  ownerId: userId,
  attestedAt: "2026-09-16T12:00:00Z",
  officialDomain: "synthetic.example.com",
  recordId: "22222222-2222-4222-8222-222222222222",
  postingContentHash: "a".repeat(64),
  sourceUrl: "https://jobs.lever.co/synthetic/role",
  quote: "Synthetic Company is the hiring employer.",
  history: [],
};
const record = (company = "Synthetic Capital", source = "lever") => ({
  company,
  details: { posting: { source, boardToken: "synthetic", sourceRegion: "eu" } },
});
const tx = (alias: unknown) =>
  ({
    personalEmployerAlias: { findUnique: async () => alias },
  }) as unknown as Prisma.TransactionClient;
const policy = (maxActiveApplications: number) => ({
  canonicalEmployer,
  maxActiveApplications,
  evidence: {
    verification: "owner_attested",
    sourceUrl: "https://synthetic.example.com/careers/policy",
    sha256: "a".repeat(64),
    quote: "Candidates may have only one active application with this employer.",
    ownerConfirmsPolicy: true,
  },
});

describe("employer identity evidence", () => {
  it("uses exact source-backed owner-attested evidence and the Lever region", async () => {
    let query: unknown;
    const db = {
      personalEmployerAlias: {
        findUnique: async (value: unknown) => {
          query = value;
          return { canonicalEmployer, evidence };
        },
      },
    } as unknown as Prisma.TransactionClient;
    expect(await employerIdentity(db, userId, record())).toBe(canonicalEmployer);
    expect(query).toMatchObject({
      where: { userId_sourceEmployer: { userId, sourceEmployer: "lever:eu:synthetic" } },
    });
  });
  it("holds legacy and unsupported evidence instead of silently changing identity", async () => {
    for (const invalid of [
      {},
      { ...evidence, verification: "legacy_unverified" },
      { ...evidence, verification: "server_verified" },
      { ...evidence, ownerId: crypto.randomUUID() },
      { ...evidence, quote: "" },
      { ...evidence, postingContentHash: "unknown" },
      { ...evidence, sourceUrl: "http://127.0.0.1/private" },
    ])
      await expect(
        employerIdentity(tx({ canonicalEmployer, evidence: invalid }), userId, record()),
      ).rejects.toThrow("Employer alias evidence is unverified");
    await expect(
      employerIdentity(
        tx({ canonicalEmployer: "domain:another.example.com", evidence }),
        userId,
        record(),
      ),
    ).rejects.toThrow("owner attestation");
  });
  it("uses normalized exact display names only when no alias exists", async () => {
    expect(await employerIdentity(tx(null), userId, record("  Synthetic   Capital  "))).toBe(
      "name:synthetic capital",
    );
    expect(await employerIdentity(tx(null), userId, record("Synthetic Capital LLC"))).toBe(
      "name:synthetic capital llc",
    );
  });
  it("CBS and unknown sources cannot consume a board-wide alias", async () => {
    let lookups = 0;
    const db = {
      personalEmployerAlias: {
        findUnique: async () => {
          lookups++;
          throw new Error("Unexpected lookup");
        },
      },
    } as unknown as Prisma.TransactionClient;
    for (const source of ["cbs", "unknown"])
      expect(await employerIdentity(db, userId, record("Fund One", source))).toBe("name:fund one");
    expect(lookups).toBe(0);
  });
});

describe("authoritative employer application ceilings", () => {
  function database(count: number) {
    let query: unknown;
    return {
      db: {
        personalEmployerAlias: { findUnique: async () => ({ canonicalEmployer, evidence }) },
        personalAttempt: {
          findMany: async (value: unknown) => {
            query = value;
            return Array.from({ length: count }, () => ({ record: record() }));
          },
        },
      } as unknown as Prisma.TransactionClient,
      query: () => query,
    };
  }
  it("a stricter source policy counts applications across campaigns", async () => {
    const f = database(1);
    await expect(
      enforceEmployerCap(f.db, userId, canonicalEmployer, 3, undefined, async () => ({
        employerPolicies: [policy(1)],
      })),
    ).rejects.toThrow("active-application limit");
    const where = (f.query() as { where: Record<string, unknown> }).where;
    expect(where.userId).toBe(userId);
    expect(where.campaignId).toBeUndefined();
    expect(where.mode).toBe("submit");
  });
  it("an employer configuration cannot raise the user's lower cap", async () => {
    const f = database(1);
    await expect(
      enforceEmployerCap(f.db, userId, canonicalEmployer, 1, undefined, async () => ({
        employerPolicies: [policy(3)],
      })),
    ).rejects.toThrow("active-application limit");
  });
  it("zero employer allowance holds before any reservation exists", async () => {
    const f = database(0);
    await expect(
      enforceEmployerCap(f.db, userId, canonicalEmployer, 3, undefined, async () => ({
        employerPolicies: [policy(0)],
      })),
    ).rejects.toThrow("active-application limit");
  });
  it("absent employer policy uses the user cap and preserves the current-attempt exclusion", async () => {
    const f = database(1);
    await enforceEmployerCap(f.db, userId, canonicalEmployer, 3, "current", async () => ({}));
    expect(f.query()).toMatchObject({ where: { id: { not: "current" } } });
  });
  it("invalid source policies and duplicate canonical employers hold", async () => {
    const f = database(0);
    for (const employerPolicies of [
      null,
      [policy(4)],
      [policy(-1)],
      [policy(1), policy(2)],
      [{ ...policy(1), evidence: { ...policy(1).evidence, ownerConfirmsPolicy: false } }],
      [{ ...policy(1), evidence: { ...policy(1).evidence, sha256: "unknown" } }],
    ])
      await expect(
        enforceEmployerCap(f.db, userId, canonicalEmployer, 3, undefined, async () => ({
          employerPolicies,
        })),
      ).rejects.toThrow("policies are invalid");
  });
  it("a display name does not claim a canonical source policy", async () => {
    const f = database(0);
    await enforceEmployerCap(f.db, userId, "name:synthetic", 3, undefined, async () => {
      throw new Error("Unexpected private configuration read");
    });
  });
});
