import { run } from "@grammyjs/runner";
import { loadConfig, loadDotEnv } from "./config.js";
import { logger } from "./logger.js";
import { openDatabase } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { pruneFalseChangeEvents } from "./db/cleanup.js";
import { PortalClient } from "./portal/client.js";
import { ScheduleService } from "./schedule/service.js";
import { createBot, registerCommands } from "./bot/index.js";
import { Notifier } from "./notify/dispatcher.js";
import { startScheduler } from "./scheduler/index.js";
import { createPooledRenderer } from "./render/pool.js";
import { AskService, type StudentLookup } from "./ai/ask.js";
import { TeacherService } from "./portal/teachers.js";
import { WebinarService } from "./portal/webinars.js";
import { NewsScanner } from "./news/scanner.js";
import type { Deps } from "./bot/context.js";
import { createHttpServer } from "./http/server.js";
import { StudentDirectory } from "./students/directory.js";
import { KnownPeople } from "./students/known.js";
import { resolveStudentGroup, whereNowText } from "./students/locate.js";
import { filterSubgroup } from "./schedule/format.js";
import { todayMsk } from "./time.js";
import { QaBase } from "./chat/qa.js";
import { ChatService } from "./chat/service.js";
import { importLegacyCanned } from "./chat/importCanned.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;
  logger.info({ node: process.version, faculty: config.FACULTY_ID }, "starting vish-bot");

  const db = openDatabase(config.DB_PATH);
  const repo = new Repo(db);
  // Разовая уборка после правки правил сравнения: ложные «изменения», которых
  // по нынешним правилам не было бы вовсе, уходят из раздела «Изменения».
  pruneFalseChangeEvents(repo);
  // Один клиент портала на всё. Если учётка задана, он ходит под ней — только
  // она видит преподавателей в расписании групп; не пустила — сам садится
  // гостем, и расписание продолжает работать, просто без фамилий. Двух
  // параллельных систем нет нарочно: две очереди запросов к порталу — это
  // двойная нагрузка и два разных ответа на один и тот же вопрос.
  const portal = new PortalClient({
    insecureTls: config.PORTAL_TLS_INSECURE,
    proxyUrl: config.HTTPS_PROXY,
    ...(config.PORTAL_LOGIN && config.PORTAL_PASSWORD ? { credentials: { login: config.PORTAL_LOGIN, password: config.PORTAL_PASSWORD } } : {}),
  });
  const service = new ScheduleService(repo, portal, { facultyId: config.FACULTY_ID, hiddenPrefixes: config.HIDDEN_GROUP_PREFIXES });
  // Posters are drawn in a child process that is recycled: resvg never frees a
  // rendered pixmap, so the memory only comes back when that process ends.
  const renderer = await createPooledRenderer({ theme: config.POSTER_THEME }).catch((err) => {
    logger.warn({ err: String(err) }, "image renderer unavailable, text only");
    return null;
  });
  const teachers = config.PORTAL_LOGIN && config.PORTAL_PASSWORD ? new TeacherService(portal, repo, service) : null;
  if (!teachers) logger.info("teacher schedules disabled: PORTAL_LOGIN/PORTAL_PASSWORD not set");
  // The webinar page is guest-readable and is the only source of teacher names without an account.
  const webinars = new WebinarService(portal, repo, config.FACULTY_ID);
  // «Сыск»: файл со студентами лежит только на хостинге и в репозиторий не попадает.
  const students = config.POISK ? new StudentDirectory(config.POISK_DB) : null;
  // Узнавание по нику — отдельный файл и отдельный модуль: ники не должны
  // попасть в поиск студентов даже по ошибке. Нет файла — никого не узнаём.
  const known = new KnownPeople(config.KNOWN_DB);
  // Реестр преподавателей для режима преподавателя: тот же формат «ФИО;ник».
  const teacherRegistry = new KnownPeople(config.TEACHERS_DB);
  logger.info({ count: teacherRegistry.count(), file: config.TEACHERS_DB }, teacherRegistry.count() ? "teacher registry loaded" : "teacher registry is empty or missing: режим преподавателя — только для админов (/prepod Фамилия)");
  logger.info({ count: known.count(), file: config.KNOWN_DB }, known.count() ? "known people loaded" : "known people file is empty or missing: бот никого не узнаёт по имени");
  if (students) {
    const st = students.stats();
    // POISK=TRUE с ненайденным файлом — это мёртвый раздел у всех: это ошибка, а не «info».
    if (st.error || !st.count) logger.error({ file: config.POISK_DB, err: st.error }, "POISK=TRUE, но справочник студентов не прочитан: раздел «Где студент» работать не будет");
    else logger.info({ count: st.count, file: config.POISK_DB }, "global student search enabled");
  } else {
    logger.info("global student search disabled (POISK=FALSE)");
  }

  // Реестр студентов виден ИИ-поиску через узкий интерфейс: сам AskService не
  // знает ни про лимиты, ни про журнал — это дело бота.
  const studentLookup: StudentLookup | null = students
    ? {
        search: (query, limit) => students.search(query, limit).map((h) => ({ id: h.student.id, name: h.student.name, groupTitle: h.student.groupTitle, subgroup: h.student.subgroup, fuzzy: h.fuzzy })),
        allowed: (userId) => config.POISK_DAILY_LIMIT <= 0 || config.ADMIN_IDS.includes(userId) || repo.poiskUsage(userId, todayMsk()) < config.POISK_DAILY_LIMIT,
        note: (userId, query, studentId) => repo.logPoisk(userId, todayMsk(), `ии: ${query}`, studentId),
        whereabouts: (studentId) => {
          const st = students.get(studentId);
          if (!st) return null;
          const { group, ambiguous } = resolveStudentGroup(service.groups(), st);
          if (!group) {
            // Под одним номером в расписании бывает две разные группы: молча
            // выбрать одну — значит показать чужие пары как его.
            return ambiguous.length
              ? `В расписании под «${st.groupTitle}» несколько разных групп (${ambiguous.map((g) => g.title).join(", ")}), поэтому где он сейчас — сказать нельзя.`
              : "Группы этого человека нет в расписании ВИШ.";
          }
          const today = todayMsk();
          const lessons = filterSubgroup(service.lessonsOn(group, today), st.subgroup);
          return whereNowText(lessons, today, today, st.subgroup).replace(/<[^>]+>/g, "");
        },
      }
    : null;
  const ask = config.ANTHROPIC_API_KEY ? new AskService(config.ANTHROPIC_API_KEY, service, { model: config.AI_MODEL }, teachers, webinars, studentLookup) : null;

  // Болталка в группах: свой ключ (свой счёт) или общий; сценарий «вопрос → ответ» — файл на хостинге.
  const chatKey = config.CHAT_ANTHROPIC_API_KEY ?? config.ANTHROPIC_API_KEY;
  const chat =
    config.CHAT_AI && chatKey
      ? new ChatService(chatKey, { model: config.CHAT_AI_MODEL ?? config.AI_MODEL, contextMessages: config.CHAT_CONTEXT_MESSAGES, botUsername: null }, new QaBase(config.CHAT_QA_DB))
      : null;
  if (config.CHAT_AI && !chatKey) logger.warn("болталка в группах выключена: нет ни CHAT_ANTHROPIC_API_KEY, ни ANTHROPIC_API_KEY");
  else if (chat) {
    // Ответы, добавленные через /reply_add в первой версии, переезжают в сценарий.
    importLegacyCanned(repo, chat.qa);
    logger.info({ model: chat.model, qa: chat.qa.stats().count, file: config.CHAT_QA_DB }, "group chat enabled");
  } else logger.info("group chat disabled (CHAT_AI=FALSE)");

  const deps: Deps = { config, repo, service, renderer, ask, teachers, webinars, students, known, teacherRegistry, chat, news: null, http: null, inline: false, botUsername: null, pending: new Map(), startedAt: new Date() };
  const bot = createBot(deps);
  await bot.init();
  chat?.setBotUsername(bot.botInfo.username ?? null);
  // Без этого «@бот привет» в группе до бота не дойдёт: Telegram присылает
  // в privacy mode только команды и ответы на сообщения бота.
  if (chat && !bot.botInfo.can_read_all_group_messages) logger.warn("group chat: privacy mode is ON — бот не увидит «@бот привет» в группах. @BotFather → /setprivacy → Disable, затем удалить и заново добавить бота в группу (или сделать его админом группы)");
  deps.news = config.ANTHROPIC_API_KEY
    ? new NewsScanner(config.ANTHROPIC_API_KEY, repo, bot.api, { lookbackHours: config.NEWS_LOOKBACK_HOURS, maxPerTopic: config.NEWS_MAX_PER_TOPIC, vkToken: config.VK_SERVICE_TOKEN, model: config.AI_MODEL })
    : null;
  if (!deps.news) logger.info("news scanner disabled: ANTHROPIC_API_KEY not set");
  deps.inline = bot.botInfo.supports_inline_queries === true;
  deps.botUsername = bot.botInfo.username ?? null;
  if (!deps.inline) logger.warn("inline mode is OFF: open @BotFather → /setinline for this bot, otherwise «@бот 12-23» does nothing in group chats");
  logger.info({ username: bot.botInfo.username, inline: deps.inline }, "bot authorised");
  await registerCommands(bot, deps);

  const notifier = new Notifier(bot.api, repo, service, renderer, config.ADMIN_IDS, webinars, teachers);
  const scheduler = startScheduler({ service, notifier, repo, busyCron: config.POLL_CRON_BUSY, idleCron: config.POLL_CRON_IDLE, newsCron: config.NEWS_SCAN_CRON, news: deps.news, teachers, webinars });

  // Calendar subscriptions + /health. Pterodactyl hands the allocated port in SERVER_PORT.
  const httpPort = config.HTTP_PORT || config.SERVER_PORT || 0;
  const http =
    httpPort > 0
      ? createHttpServer({
          repo,
          service,
          port: httpPort,
          slidesToken: config.SLIDES_TOKEN,
          slidesDir: config.SLIDES_DIR,
          // Слайды приходят с отдельного сервера записи; рассылку делает бот.
          onSlides: (deck) => void notifier.sendSlideDeck(deck).catch((err: unknown) => logger.warn({ err: String(err) }, "рассылка слайдов не удалась")),
        })
      : null;
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
    renderer?.stop();
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
