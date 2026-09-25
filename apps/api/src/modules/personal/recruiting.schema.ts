import { personalRecruitingManifestSchema } from "@jobpilot/contracts/personal-recruiting";
import { z } from "zod/v4";

const manifest = personalRecruitingManifestSchema;
const firm = manifest.shape.firms.element;
const evidence = manifest.shape.evidence.element;

const recruitingManifestDtoSchema = z.object({
  ...manifest.shape,
  updatedAt: z.date(),
  evidence: z.array(
    evidence.omit({ locator: true }).extend({ observedAt: z.date(), url: z.url().nullable() }),
  ),
  firms: z.array(
    z.object({
      ...firm.shape,
      deadline: z.object({ ...firm.shape.deadline.shape, date: z.date().nullable() }),
      events: z.array(
        z.object({
          ...firm.shape.events.element.shape,
          startAt: z.date().nullable(),
          endAt: z.date().nullable(),
        }),
      ),
      actions: z.array(
        z.object({ ...firm.shape.actions.element.shape, dueDate: z.date().nullable() }),
      ),
    }),
  ),
});

export const personalRecruitingResponseSchema = z.object({
  status: z.enum(["available", "missing", "invalid"]),
  snapshot: z
    .object({
      capturedAt: z.date(),
      source: z.object({ sha256: z.string(), gitHead: z.string(), gitDirty: z.boolean() }),
      manifest: recruitingManifestDtoSchema,
    })
    .nullable(),
});
