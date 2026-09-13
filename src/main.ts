import { run } from "@grammyjs/runner";
import { loadConfig, loadDotEnv } from "./config.js";
import { logger } from "./logger.js";
import { openDatabase } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { PortalClient } from "./portal/client.js";
import { ScheduleService } from "./schedule/service.js";
import { createBot, registerCommands } from "./bot/index.js";
import { Notifier } from "./notify/dispatcher.js";
import { startScheduler } from "./scheduler/index.js";
import { createRenderer } from "./render/image.js";
import { AskService } from "./ai/ask.js";
import { TeacherService } from "./portal/teachers.js";
import type { Deps } from "./bot/context.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;
  logger.info({ node: process.version, faculty: config.FACULTY_ID }, "starting vish-bot");

  const db = openDatabase(config.DB_PATH);
  const repo = new Repo(db);
  const portal = new PortalClient({ insecureTls: config.PORTAL_TLS_INSECURE, proxyUrl: config.HTTPS_PROXY });
  const service = new ScheduleService(repo, portal, { facultyId: config.FACULTY_ID, hiddenPrefixes: config.HIDDEN_GROUP_PREFIXES });
  const renderer = await createRenderer().catch((err) => {
    logger.warn({ err }, "image renderer unavailable, text only");
    return null;
  });
  const ask = config.ANTHROPIC_API_KEY ? new AskService(config.ANTHROPIC_API_KEY, service, { model: config.AI_MODEL }) : null;
  const teachers =
    config.PORTAL_LOGIN && config.PORTAL_PASSWORD
      ? new TeacherService(
          new PortalClient({ insecureTls: config.PORTAL_TLS_INSECURE, proxyUrl: config.HTTPS_PROXY, credentials: { login: config.PORTAL_LOGIN, password: config.PORTAL_PASSWORD } }),
          repo,
          service,
        )
      : null;
  if (!teachers) logger.info("teacher schedules disabled: PORTAL_LOGIN/PORTAL_PASSWORD not set");

  const deps: Deps = { config, repo, service, renderer, ask, teachers, pending: new Map(), startedAt: new Date() };
  const bot = createBot(deps);
  await bot.init();
  logger.info({ username: bot.botInfo.username }, "bot authorised");
  await registerCommands(bot, deps);

  const notifier = new Notifier(bot.api, repo, service, renderer);
  const scheduler = startScheduler({ service, notifier, repo, busyCron: config.POLL_CRON_BUSY, idleCron: config.POLL_CRON_IDLE });

  const runner = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member", "channel_post"] } } });
  logger.info("polling Telegram for updates");

  // Warm up: first portal poll right away (does not block Telegram handling).
  void scheduler.pollNow();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    scheduler.stop();
    if (runner.isRunning()) await runner.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await runner.task();
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
