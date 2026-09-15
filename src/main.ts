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
import { createThemedRenderer } from "./render/themes.js";
import { AskService } from "./ai/ask.js";
import { TeacherService } from "./portal/teachers.js";
import { WebinarService } from "./portal/webinars.js";
import { NewsScanner } from "./news/scanner.js";
import type { Deps } from "./bot/context.js";
import { createHttpServer } from "./http/server.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;
  logger.info({ node: process.version, faculty: config.FACULTY_ID }, "starting vish-bot");

  const db = openDatabase(config.DB_PATH);
  const repo = new Repo(db);
  const portal = new PortalClient({ insecureTls: config.PORTAL_TLS_INSECURE, proxyUrl: config.HTTPS_PROXY });
  const service = new ScheduleService(repo, portal, { facultyId: config.FACULTY_ID, hiddenPrefixes: config.HIDDEN_GROUP_PREFIXES });
  const renderer = await createThemedRenderer(config.POSTER_THEME).catch((err) => {
    logger.warn({ err }, "image renderer unavailable, text only");
    return null;
  });
  const teachers =
    config.PORTAL_LOGIN && config.PORTAL_PASSWORD
      ? new TeacherService(
          new PortalClient({ insecureTls: config.PORTAL_TLS_INSECURE, proxyUrl: config.HTTPS_PROXY, credentials: { login: config.PORTAL_LOGIN, password: config.PORTAL_PASSWORD } }),
          repo,
          service,
        )
      : null;
  if (!teachers) logger.info("teacher schedules disabled: PORTAL_LOGIN/PORTAL_PASSWORD not set");
  // The webinar page is guest-readable and is the only source of teacher names without an account.
  const webinars = new WebinarService(portal, repo, config.FACULTY_ID);
  const ask = config.ANTHROPIC_API_KEY ? new AskService(config.ANTHROPIC_API_KEY, service, { model: config.AI_MODEL }, teachers, webinars) : null;

  const deps: Deps = { config, repo, service, renderer, ask, teachers, webinars, news: null, http: null, pending: new Map(), startedAt: new Date() };
  const bot = createBot(deps);
  await bot.init();
  deps.news = config.ANTHROPIC_API_KEY
    ? new NewsScanner(config.ANTHROPIC_API_KEY, repo, bot.api, { lookbackHours: config.NEWS_LOOKBACK_HOURS, maxPerTopic: config.NEWS_MAX_PER_TOPIC, vkToken: config.VK_SERVICE_TOKEN, model: config.AI_MODEL })
    : null;
  if (!deps.news) logger.info("news scanner disabled: ANTHROPIC_API_KEY not set");
  logger.info({ username: bot.botInfo.username }, "bot authorised");
  await registerCommands(bot, deps);

  const notifier = new Notifier(bot.api, repo, service, renderer, config.ADMIN_IDS, webinars);
  const scheduler = startScheduler({ service, notifier, repo, busyCron: config.POLL_CRON_BUSY, idleCron: config.POLL_CRON_IDLE, newsCron: config.NEWS_SCAN_CRON, news: deps.news, teachers, webinars });

  // Calendar subscriptions + /health. Pterodactyl hands the allocated port in SERVER_PORT.
  const httpPort = config.HTTP_PORT || config.SERVER_PORT || 0;
  const http = httpPort > 0 ? createHttpServer({ repo, service, port: httpPort }) : null;
  deps.http = http;
  if (!http) logger.info("http server disabled: HTTP_PORT/SERVER_PORT not set");
  else if (!config.PUBLIC_URL) logger.warn("PUBLIC_URL not set: calendar subscription links are hidden in the bot");

  const runner = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member", "channel_post"] } } });
  logger.info("polling Telegram for updates");

  // Warm up: first portal poll right away (does not block Telegram handling).
  void scheduler.pollNow();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    scheduler.stop();
    http?.close();
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
