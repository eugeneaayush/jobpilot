import { z } from "zod/v4";

export const personalSenioritySchema = z.object({
  classification: z.enum([
    "graduate_recruiting",
    "experienced_professional",
    "undergraduate_entry",
    "unresolved",
  ]),
  reasons: z.array(z.string()),
  evidence: z.array(z.object({ field: z.enum(["title", "description"]), quote: z.string() })),
});
