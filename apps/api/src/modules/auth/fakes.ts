import type { Mailer, MailMessage } from "@/common/mail/mailer";
import type { PrismaClient } from "@/generated/prisma/client";
import { setSystemTime } from "bun:test";

type Row = Record<string, unknown>;
type OrderBy = Record<string, "asc" | "desc">;

/** One recorded email; the magic link is pulled out of the React body element. */
export interface SentMail {
  to: string;
  subject: string;
  link: string;
}

export function makeMailer(): { mailer: Mailer; sent: SentMail[] } {
  const sent: SentMail[] = [];
  const mailer: Mailer = {
    send: async (message: MailMessage) => {
      sent.push({
        to: message.to,
        subject: message.subject,
        link: (message.react.props as { link: string }).link,
      });
    },
  };
  return { mailer, sent };
}

/** Equality where-filter plus `null` and `{ not }` - every clause the auth flows issue. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (typeof condition === "object" && condition !== null && "not" in condition) {
      return row[key] !== (condition as Row).not;
    }
    return row[key] === condition;
  });
}

function pick(row: Row, select: Row): Row {
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

/** Prisma's single-column `orderBy`; the auth queries only ever sort on a Date column. */
function sorted(table: Row[], orderBy?: OrderBy): Row[] {
  const [column, direction] = Object.entries(orderBy ?? {})[0] ?? [];
  if (!column) return [...table];
  const sign = direction === "desc" ? -1 : 1;
  return [...table].sort((a, b) => sign * (Number(a[column]) - Number(b[column])));
}

export interface AuthDbState {
  users: Row[];
  refreshTokens: Row[];
  verificationTokens: Row[];
  apiTokens: Row[];
  jobBoards: Row[];
  userJobBoards: Row[];
  oauthAccounts: Row[];
  /** Thrown by the next user.create - simulates the concurrent-signup unique violation. */
  nextCreateError?: unknown;
}

/** In-memory tables covering every query AuthService/VerificationService/ApiTokenService issue. */
export function makeAuthDb(over: Partial<AuthDbState> = {}) {
  const rows: AuthDbState = {
    users: [],
    refreshTokens: [],
    verificationTokens: [],
    apiTokens: [],
    jobBoards: [],
    userJobBoards: [],
    oauthAccounts: [],
    ...over,
  };
  const ids = { user: 0, refreshToken: 0, verificationToken: 0, apiToken: 0 };
  const byUnique = (table: Row[], where: Row) => table.find((row) => matches(row, where));
  const notFound = () => Object.assign(new Error("Record not found"), { code: "P2025" });

  const user = {
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = byUnique(rows.users, where);
      if (!row) return null;
      return include?.oauthAccounts
        ? { ...row, oauthAccounts: rows.oauthAccounts.filter((a) => a.userId === row.id) }
        : row;
    },
    create: async ({ data }: { data: Row }) => {
      if (rows.nextCreateError) {
        const error = rows.nextCreateError;
        rows.nextCreateError = undefined;
        throw error;
      }
      const { jobBoards, ...fields } = data;
      const links =
        (jobBoards as { createMany: { data: Row[] } } | undefined)?.createMany.data ?? [];
      const row = {
        id: `user-${++ids.user}`,
        role: "USER",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...fields,
      };
      rows.users.push(row);
      for (const link of links) {
        rows.userJobBoards.push({
          id: `ujb-${rows.userJobBoards.length + 1}`,
          userId: row.id,
          ...link,
        });
      }
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = byUnique(rows.users, where);
      if (!row) throw notFound();
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  const refreshToken = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: `refresh-${++ids.refreshToken}`, revokedAt: null, ...data };
      rows.refreshTokens.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) => byUnique(rows.refreshTokens, where) ?? null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = byUnique(rows.refreshTokens, where);
      if (!row) throw notFound();
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.refreshTokens.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  };

  const verificationToken = {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `verification-${++ids.verificationToken}`,
        consumedAt: null,
        newEmail: null,
        ...data,
      };
      rows.verificationTokens.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) =>
      byUnique(rows.verificationTokens, where) ?? null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = byUnique(rows.verificationTokens, where);
      if (!row) throw notFound();
      Object.assign(row, data);
      return row;
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const hit = rows.verificationTokens.filter((row) => matches(row, where));
      rows.verificationTokens = rows.verificationTokens.filter((row) => !hit.includes(row));
      return { count: hit.length };
    },
  };

  const apiToken = {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `api-token-${++ids.apiToken}`,
        tokenCipher: null,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        ...data,
      };
      rows.apiTokens.push(row);
      return row;
    },
    findFirst: async ({ where, orderBy }: { where: Row; orderBy?: OrderBy }) =>
      sorted(rows.apiTokens, orderBy).find((row) => matches(row, where)) ?? null,
    findMany: async ({
      where,
      select,
      orderBy,
    }: {
      where: Row;
      select?: Row;
      orderBy?: OrderBy;
    }) => {
      const hit = sorted(rows.apiTokens, orderBy).filter((row) => matches(row, where));
      return select ? hit.map((row) => pick(row, select)) : hit;
    },
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = byUnique(rows.apiTokens, where);
      if (!row) return null;
      return include?.user
        ? { ...row, user: byUnique(rows.users, { id: row.userId }) ?? null }
        : row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = byUnique(rows.apiTokens, where);
      if (!row) throw notFound();
      Object.assign(row, data);
      return row;
    },
  };

  const db = {
    user,
    refreshToken,
    verificationToken,
    apiToken,
    jobBoard: {
      findMany: async ({ where }: { where: Row }) =>
        rows.jobBoards.filter((row) => matches(row, where)),
    },
    $transaction: (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => Promise<unknown>)(db),
  };

  return { db: db as unknown as PrismaClient, rows };
}

/** Freeze both Date.now() and `new Date()`: services stamp expiries with one and check them
 *  with the other. Returns the restore; call it in afterEach or the frozen clock leaks into
 *  every later file in the shared test process. */
export function freezeClock(ms: number): () => void {
  setSystemTime(new Date(ms));
  return () => setSystemTime();
}
