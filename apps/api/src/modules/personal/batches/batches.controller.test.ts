import { Elysia } from "elysia";
import { errorMiddleware } from "@/common/middleware/error.middleware";
import { httpErrorResponses } from "@/types/response";
import { personalBatchesController } from "./batches.controller";
import { describe, expect, test } from "bun:test";

const app = new Elysia()
  .use(errorMiddleware)
  .guard({ as: "scoped", response: httpErrorResponses })
  .group("/api", (api) => api.use(personalBatchesController));

describe("batch route authentication", () => {
  test("every batch endpoint requires authentication before loading source facts", async () => {
    const paths = [
      ["GET", "/api/personal/batches/"],
      ["POST", "/api/personal/batches/"],
      ["POST", "/api/personal/batches/suggest"],
      ["GET", `/api/personal/batches/${crypto.randomUUID()}`],
      ["POST", `/api/personal/batches/${crypto.randomUUID()}/advance`],
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
