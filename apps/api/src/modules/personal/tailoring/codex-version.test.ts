import { runCodexTailoring } from "./codex";
import { protocol, temporary } from "./codex-test-fixtures";
import { sourceFixture } from "./fakes";
import { expect, test } from "bun:test";

for (const userAgent of ["codex-cli/0.154.0-alpha.6.2", "Codex Desktop/0.155.0-alpha.2.6"])
  test(`verified protocol version ${userAgent} can perform bounded tailoring`, async () =>
    temporary(async (root) => {
      const fake = protocol("valid", "openai", undefined, { userAgent });
      const result = await runCodexTailoring(sourceFixture().input, {
        runtimeDir: root,
        privateRoot: root,
        approval: { provider: "openai", allowApplicantData: true },
        transport: async () => fake.transport,
      });
      expect(result.status).toBe("proposed");
      expect(fake.messages.some((message) => message.method === "turn/start")).toBe(true);
    }));

for (const userAgent of [
  "Codex Desktop/0.155.0-alpha.2.60",
  "Codex Desktop/0.155.0-alpha.2.6-unverified",
  "Codex Desktop/0.156.0",
  "Codex Desktop/unknown",
])
  test(`unverified protocol version ${userAgent} never receives applicant input`, async () =>
    temporary(async (root) => {
      const fake = protocol("valid", "openai", undefined, { userAgent });
      const result = await runCodexTailoring(sourceFixture().input, {
        runtimeDir: root,
        privateRoot: root,
        approval: { provider: "openai", allowApplicantData: true },
        transport: async () => fake.transport,
      });
      expect(result).toMatchObject({
        status: "blocked",
        diagnostic: { phase: "initialize", code: "version_unverified" },
      });
      expect(fake.messages).toHaveLength(1);
      expect(fake.closed()).toBe(true);
    }));
