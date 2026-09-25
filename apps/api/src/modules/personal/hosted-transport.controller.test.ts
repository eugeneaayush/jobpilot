import { Elysia } from "elysia";
import { signAccessToken } from "@/common/auth/tokens";
import { errorMiddleware } from "@/common/middleware/error.middleware";
import { env } from "@/env";
import { ApiTokenService } from "@/modules/auth/api-token.service";
import { httpErrorResponses } from "@/types/response";
import { personalHostedTransportController } from "./hosted-transport.controller";
import { PersonalHostedTransportService } from "./hosted-transport.service";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

const user = {
  id: "10000000-0000-4000-8000-000000000004",
  email: "synthetic@example.test",
  role: "USER" as const,
};
const attemptId = "20000000-0000-4000-8000-000000000004";
const app = new Elysia()
  .use(errorMiddleware)
  .guard({ as: "scoped", response: httpErrorResponses })
  .use(personalHostedTransportController);
const originalMode = env.PERSONAL_MODE;
let jwt: string;
const verify = spyOn(ApiTokenService.prototype, "verify");
const freeze = spyOn(PersonalHostedTransportService.prototype, "freeze");
function request(headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  return new Request(`http://localhost/personal/attempts/${attemptId}/hosted-transport/freeze`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      leaseOwner: "synthetic-broker",
      leaseGeneration: 1,
      evidenceHash: "a".repeat(64),
      ...extra,
    }),
  });
}
describe("hosted transport broker token boundary", () => {
  beforeAll(async () => {
    env.PERSONAL_MODE = false;
    jwt = await signAccessToken(user);
    verify.mockImplementation(async (raw) => (raw === "synthetic-broker-pat" ? user : null));
    freeze.mockImplementation(async () => ({
      attemptId,
      provider: "lever",
      status: "frozen",
      evidenceHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      requestBodyHash: "c".repeat(64),
      applicationPayloadHash: "d".repeat(64),
      targetUrl: "https://jobs.lever.co/synthetic/40000000-0000-4000-8000-000000000001/apply",
      capturedAt: new Date(),
    }));
  });
  afterAll(() => {
    env.PERSONAL_MODE = originalMode;
    verify.mockRestore();
    freeze.mockRestore();
  });
  test("rejects anonymous, web JWT, cookie and unverified bearer invocations", async () => {
    const cases: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${jwt}` },
      { cookie: `accessToken=${jwt}` },
      { authorization: "Bearer wrong" },
    ];
    for (const headers of cases) {
      const response = await app.handle(request(headers));
      expect(response.status).toBe(401);
    }
    expect(freeze).not.toHaveBeenCalled();
  });
  test("accepts the verified agent PAT and rejects fields beyond the freeze contract", async () => {
    const response = await app.handle(request({ authorization: "Bearer synthetic-broker-pat" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "lever", status: "frozen" });
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.handle(
          request(
            { authorization: "Bearer synthetic-broker-pat" },
            { requestBody: "caller must not supply raw bytes through the API" },
          ),
        )
      ).status,
    ).toBe(422);
    expect(freeze).toHaveBeenCalledTimes(1);
  });
});
