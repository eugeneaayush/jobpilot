import {
  isProtectedVariantLabel,
  resumeDataSchema,
  resumeVariantCreateSchema,
  resumeVariantPatchSchema,
} from "./resume";
import { describe, expect, it } from "bun:test";

const UUID = "3f2c3f1e-0d5c-4f6a-9b8e-1a2b3c4d5e6f";

describe("resumeDataSchema", () => {
  it("defaults every section to an empty list", () => {
    const parsed = resumeDataSchema.parse({ basics: { name: "Ada Lovelace" } });
    expect(parsed.basics).toEqual({ name: "Ada Lovelace" });
    expect(parsed.experience).toEqual([]);
    expect(parsed.projects).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.education).toEqual([]);
    expect(parsed.publications).toEqual([]);
    expect(parsed.awards).toEqual([]);
    expect(parsed.certifications).toEqual([]);
    expect(parsed.sections).toEqual([]);
  });

  it("requires a basics object with a non-empty name", () => {
    expect(resumeDataSchema.safeParse({}).success).toBe(false);
    expect(resumeDataSchema.safeParse({ basics: { name: "" } }).success).toBe(false);
  });

  it("normalizes link fields by trimming and adding the https prefix", () => {
    const parsed = resumeDataSchema.parse({
      basics: { name: "Ada", website: "example.com", linkedin: "  https://linkedin.com/in/ada  " },
    });
    expect(parsed.basics.website).toBe("https://example.com");
    expect(parsed.basics.linkedin).toBe("https://linkedin.com/in/ada");
    expect(parsed.basics.github).toBeUndefined();
  });

  it("keeps a blank link empty so optional URL fields round-trip", () => {
    const parsed = resumeDataSchema.parse({ basics: { name: "Ada", website: "   " } });
    expect(parsed.basics.website).toBe("");
  });

  it("accepts an empty email but rejects a malformed one", () => {
    expect(resumeDataSchema.safeParse({ basics: { name: "Ada", email: "" } }).success).toBe(true);
    expect(
      resumeDataSchema.safeParse({ basics: { name: "Ada", email: "ada at example" } }).success,
    ).toBe(false);
  });

  it("requires company, title, start, and a bullets list per experience", () => {
    const experience = { company: "Acme", title: "Engineer", start: "2020", bullets: [] };
    expect(
      resumeDataSchema.safeParse({ basics: { name: "A" }, experience: [experience] }).success,
    ).toBe(true);
    for (const dropped of ["company", "title", "start", "bullets"]) {
      const row: Record<string, unknown> = { ...experience };
      delete row[dropped];
      expect(resumeDataSchema.safeParse({ basics: { name: "A" }, experience: [row] }).success).toBe(
        false,
      );
    }
  });

  it("defaults the list fields on the softer sections", () => {
    const parsed = resumeDataSchema.parse({
      basics: { name: "A" },
      projects: [{ name: "Analytical Engine" }],
      education: [{ school: "Cambridge", degree: "MA" }],
      sections: [{ title: "Talks" }],
    });
    expect(parsed.projects[0].bullets).toEqual([]);
    expect(parsed.projects[0].keywords).toEqual([]);
    expect(parsed.education[0].details).toEqual([]);
    expect(parsed.sections[0].entries).toEqual([]);
  });

  it("requires a non-empty heading on every custom entry", () => {
    expect(
      resumeDataSchema.safeParse({
        basics: { name: "A" },
        sections: [{ title: "Talks", entries: [{ heading: "" }] }],
      }).success,
    ).toBe(false);
  });
});

describe("resumeVariantCreateSchema", () => {
  it("requires a label and full resume content", () => {
    expect(
      resumeVariantCreateSchema.safeParse({ label: "Backend", content: { basics: { name: "A" } } })
        .success,
    ).toBe(true);
    expect(
      resumeVariantCreateSchema.safeParse({ label: "", content: { basics: { name: "A" } } })
        .success,
    ).toBe(false);
    expect(resumeVariantCreateSchema.safeParse({ label: "Backend" }).success).toBe(false);
  });

  it("takes a nullable applicationId and diffNotes", () => {
    const variant = resumeVariantCreateSchema.parse({
      label: "Backend",
      content: { basics: { name: "A" } },
      applicationId: null,
      diffNotes: null,
    });
    expect(variant.applicationId).toBe(null);
    expect(variant.diffNotes).toBe(null);
  });

  it("rejects a malformed applicationId", () => {
    expect(
      resumeVariantCreateSchema.safeParse({
        label: "Backend",
        content: { basics: { name: "A" } },
        applicationId: "nope",
      }).success,
    ).toBe(false);
    expect(
      resumeVariantCreateSchema.safeParse({
        label: "Backend",
        content: { basics: { name: "A" } },
        applicationId: UUID,
      }).success,
    ).toBe(true);
  });
});

describe("resumeVariantPatchSchema", () => {
  it("allows an empty patch but not an empty label or invalid content", () => {
    expect(resumeVariantPatchSchema.parse({})).toEqual({});
    expect(resumeVariantPatchSchema.safeParse({ label: "" }).success).toBe(false);
    expect(resumeVariantPatchSchema.safeParse({ content: { basics: { name: "" } } }).success).toBe(
      false,
    );
  });
});

describe("isProtectedVariantLabel", () => {
  it("shields the suggested-rewrite label and its variants, case-sensitively", () => {
    expect(isProtectedVariantLabel("Suggested rewrite")).toBe(true);
    expect(isProtectedVariantLabel("Suggested rewrite v2")).toBe(true);
    expect(isProtectedVariantLabel("suggested rewrite")).toBe(false);
    expect(isProtectedVariantLabel("My rewrite")).toBe(false);
  });
});
