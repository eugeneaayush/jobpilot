import { type DuplicateReader, findAppliedDuplicate } from "./duplicate";
import { expect, it } from "bun:test";

it("keeps exact canonical URLs duplicate forever and does not scan fuzzy candidates", async () => {
  const old = {
    id: "old",
    url: "https://example.test/jobs/42",
    title: "Engineer",
    company: "Example",
    appliedAt: new Date("2000-01-01"),
    status: "applied",
  };
  let scans = 0;
  const reader = {
    application: {
      findUnique: async ({ where }: { where: { userId_url: { userId: string; url: string } } }) =>
        where.userId_url.userId === "owner" && where.userId_url.url === old.url ? old : null,
      findMany: async () => {
        scans++;
        return [];
      },
    },
  } as unknown as DuplicateReader;
  expect(
    (
      await findAppliedDuplicate(reader, "owner", {
        url: "http://www.example.test/jobs/42?utm_source=test",
      })
    )?.kind,
  ).toBe("url");
  expect(scans).toBe(0);
  expect(await findAppliedDuplicate(reader, "other", { url: old.url })).toBeNull();
});
