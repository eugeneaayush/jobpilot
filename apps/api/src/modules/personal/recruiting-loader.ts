import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { personalRecruitingSnapshotSchema } from "@jobpilot/contracts/personal-recruiting";
import type { z } from "zod/v4";
import type { personalRecruitingResponseSchema } from "./recruiting.schema";

type RecruitingResponse = z.infer<typeof personalRecruitingResponseSchema>;
const maximumBytes = 2 * 1024 * 1024;

function officialUrl(kind: string, locator: string): string | null {
  if (kind !== "official_page") return null;
  try {
    const url = new URL(locator);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export async function readRecruitingDashboard(root: string): Promise<RecruitingResponse> {
  try {
    const absoluteRoot = path.resolve(root);
    const rootInfo = await lstat(absoluteRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0)
      return { status: "invalid", snapshot: null };
    const directory = path.join(await realpath(absoluteRoot), "recruiting");
    const directoryInfo = await lstat(directory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      (directoryInfo.mode & 0o077) !== 0
    )
      return { status: "invalid", snapshot: null };
    const filePath = path.join(directory, "latest.json");
    const file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let contents: string;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > maximumBytes ||
        (info.mode & 0o077) !== 0 ||
        info.nlink !== 1 ||
        (await realpath(directory)) !== directory
      )
        return { status: "invalid", snapshot: null };
      const bytes = await file.readFile();
      if (bytes.byteLength > maximumBytes) return { status: "invalid", snapshot: null };
      contents = bytes.toString("utf8");
    } finally {
      await file.close();
    }
    const parsed = personalRecruitingSnapshotSchema.safeParse(JSON.parse(contents));
    if (!parsed.success) return { status: "invalid", snapshot: null };
    const { capturedAt, source, manifest } = parsed.data;
    return {
      status: "available",
      snapshot: {
        capturedAt: new Date(capturedAt),
        source: { sha256: source.sha256, gitHead: source.gitHead, gitDirty: source.gitDirty },
        manifest: {
          ...manifest,
          updatedAt: new Date(manifest.updatedAt),
          evidence: manifest.evidence.map(({ locator, observedAt, ...item }) => ({
            ...item,
            observedAt: new Date(observedAt),
            url: officialUrl(item.kind, locator),
          })),
          firms: manifest.firms.map((firm) => ({
            ...firm,
            deadline: { ...firm.deadline, date: dateOrNull(firm.deadline.date) },
            events: firm.events.map((event) => ({
              ...event,
              startAt: dateOrNull(event.startAt),
              endAt: dateOrNull(event.endAt),
            })),
            actions: firm.actions.map((action) => ({
              ...action,
              dueDate: dateOrNull(action.dueDate),
            })),
          })),
        },
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing", snapshot: null };
    return { status: "invalid", snapshot: null };
  }
}
