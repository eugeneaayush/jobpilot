import { pino } from "pino";
import { env } from "@/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "authorization",
      "cookie",
      "password",
      "token",
      "apiToken",
      "accessToken",
      "refreshToken",
      "email",
      "phone",
      "answers",
      "securityCode",
      "security_code",
      "body.code",
      "req.body.code",
      "resume",
      "headers.authorization",
      "headers.cookie",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});
