import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { render } from "@react-email/render";
import { singleton } from "tsyringe";
import { logger } from "@/common/logger";
import { env } from "@/env";
import type { Mailer, MailMessage } from "./mailer";

/**
 * Logs the rendered email (incl. any magic links) instead of sending. Bound to
 * the {@link MAILER} token when RESEND_API_KEY is unset, so local dev can copy
 * links out of the API console without a real email provider.
 */
@singleton()
export class ConsoleMailer implements Mailer {
  async send({ to, subject, react }: MailMessage): Promise<void> {
    const text = await render(react, { plainText: true });
    if (env.PERSONAL_MODE) {
      const directory = path.join(env.STORAGE_ROOT, "mail");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(directory, `${crypto.randomUUID()}.txt`),
        `To: ${to}\nSubject: ${subject}\n\n${text}`,
        { mode: 0o600 },
      );
      logger.info("Account email saved in private runtime mail directory");
      return;
    }
    logger.info({ to, subject }, `[mail] would send "${subject}" to ${to}\n${text}`);
  }
}
