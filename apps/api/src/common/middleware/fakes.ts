import { db } from "@/common/database/prisma.client";

/** Point the shared db singleton's `user` delegate at a fake; returns the restore.
 *  Prisma delegates ignore spyOn, and mock.module would leak into every later test file. */
export function fakeUserDelegate(findUnique: () => Promise<unknown>): () => void {
  const real = db.user;
  Object.defineProperty(db, "user", { value: { findUnique }, configurable: true, writable: true });
  return () => {
    Object.defineProperty(db, "user", { value: real, configurable: true, writable: true });
  };
}
