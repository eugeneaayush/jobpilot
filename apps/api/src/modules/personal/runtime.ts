import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type PersonalSettings, personalSettingsSchema } from "@jobpilot/contracts/personal";
import { badRequest, forbidden } from "@/common/errors";
import { env } from "@/env";
import type { Prisma } from "@/generated/prisma/client";

export function personalRoot(): string {
  if (!env.PERSONAL_MODE || !env.JOBPILOT_PERSONAL_ROOT)
    throw badRequest("Private runtime is not configured; run personal:setup");
  return path.resolve(env.JOBPILOT_PERSONAL_ROOT);
}
export const jsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const textValue = (value: unknown): string => (typeof value === "string" ? value : "");
export const stringsValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export async function savePrivate(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}
export async function runtimeConfiguration(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(personalRoot(), "runtime.json"), "utf8"));
}
/** Read global applicant sources only for the explicitly configured private account. */
export async function personalConfiguration(userId: string): Promise<Record<string, unknown>> {
  let config: Record<string, unknown>;
  try {
    config = await runtimeConfiguration();
  } catch {
    throw forbidden("Private account access is unavailable");
  }
  const owner = objectValue(config.account).userId;
  if (typeof owner !== "string" || !owner || owner !== userId)
    throw forbidden("This account cannot access the private runtime");
  return config;
}
export async function readSettings(userId: string): Promise<PersonalSettings> {
  try {
    return personalSettingsSchema.parse(
      JSON.parse(await readFile(path.join(personalRoot(), "settings", `${userId}.json`), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const config = await personalConfiguration(userId);
    return personalSettingsSchema.parse(objectValue(config.candidate));
  }
}
