import { createHash } from "node:crypto";
import path from "node:path";
import { db } from "../../apps/api/src/common/database/prisma.client";
import { privateWrite, readConfig, runtimeRoot } from "./common";

const config = await readConfig();
let user = await db.user.findUnique({ where: { email: config.account.email } });
if (!user) {
  user = await db.user.create({
    data: {
      email: config.account.email,
      username: "private-applicant",
      passwordHash: await Bun.password.hash(config.account.password),
      emailVerified: true,
      firstName: "Private",
      lastName: "Applicant",
    },
  });
}
if (!config.account.token) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  await db.apiToken.create({
    data: {
      userId: user.id,
      name: "private-local-runtime",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    },
  });
  config.account.token = token;
}
config.account.userId = user.id;
await privateWrite(path.join(runtimeRoot, "runtime.json"), config);
await db.$disconnect();
