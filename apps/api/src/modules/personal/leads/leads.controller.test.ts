import { Elysia } from "elysia";
import { errorMiddleware } from "@/common/middleware/error.middleware";
import { httpErrorResponses } from "@/types/response";
import { personalLeadsController } from "./leads.controller";
import { describe, expect, test } from "bun:test";

const app = new Elysia()
  .use(errorMiddleware)
  .guard({ as: "scoped", response: httpErrorResponses })
  .group("/api", (api) => api.use(personalLeadsController));

describe("lead routes retain authentication and strict input contracts", () => {
  test("all lead route groups require authentication before service access", async () => {
    const paths = [
      ["GET", "/api/personal/leads/"],
      ["POST", "/api/personal/leads/import"],
      ["POST", "/api/personal/leads/discover"],
      ["POST", "/api/personal/leads/feeds/import"],
      ["POST", `/api/personal/leads/${crypto.randomUUID()}/resolve`],
    ];
    for (const [method, route] of paths) {
      const response = await app.handle(
        new Request(`http://localhost${route}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      expect(response.status).toBe(401);
    }
  });
});
