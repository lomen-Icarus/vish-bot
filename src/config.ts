import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { logLevel } from "./logger.js";

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments, no interpolation. */
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const idList = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  );

/**
 * Числа из окружения: пустое значение («KEY=» в .env, пустая переменная в
 * панели) — это «не задано». Без этого z.coerce превращал "" в 0: лимит поиска
 * людей молча становился безлимитом, лимиты ИИ — нулём, а FACULTY_ID= ронял старт.
 */
const blankToUndefined = (v: unknown): unknown => (typeof v === "string" && !v.trim() ? undefined : v);
const num = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(blankToUndefined, inner);

const schema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN is required"),
  ADMIN_IDS: idList,
  MEDIA_CHAT_IDS: idList,
  FACULTY_ID: num(z.coerce.number().int().positive().default(32)),
  /** Group name prefixes hidden from users and skipped by the poller (part-time streams etc.). */
  HIDDEN_GROUP_PREFIXES: z
    .string()
    .default("ОЗВИШ")
    .transform((s) => s.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)),
  /** Portal account for features guests cannot use (teacher schedules). */
  PORTAL_LOGIN: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  PORTAL_PASSWORD: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /** Telegram channel/chat ids whose posts are relayed to topic subscribers by hashtag. */
  NEWS_CHANNEL_IDS: idList,
  /** VK service token (app "service key") for wall.get on VK sources. */
  VK_SERVICE_TOKEN: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  NEWS_SCAN_CRON: z.string().default("30 10 * * *"),
  NEWS_LOOKBACK_HOURS: num(z.coerce.number().int().positive().default(32)),
  NEWS_MAX_PER_TOPIC: num(z.coerce.number().int().positive().default(8)),
  DB_PATH: z.string().default("./data/vish-bot.sqlite"),
  POLL_CRON_BUSY: z.string().default("*/6 7-21 * * 1-6"),
  POLL_CRON_IDLE: z.string().default("*/30 * * * *"),
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  AI_MODEL: z.string().default("claude-sonnet-5"),
  AI_DAILY_LIMIT_PER_USER: num(z.coerce.number().int().nonnegative().default(10)),
  AI_DAILY_LIMIT_GLOBAL: num(z.coerce.number().int().nonnegative().default(300)),
  /**
   * Глобальный поиск студентов ("сыск"): TRUE включает раздел целиком, FALSE
   * прячет его полностью — ни кнопок, ни команд, ни колбэков.
   */
  POISK: z
    .string()
    .default("FALSE")
    .transform((v) => ["1", "true", "yes", "on", "да"].includes(v.trim().toLowerCase())),
  /**
   * Файл со студентами (ФИО + группа). Лежит ТОЛЬКО на хостинге рядом с базой
   * бота и никогда не попадает в репозиторий. CSV, JSON или SQLite.
   */
  POISK_DB: z.string().default("./data/students.csv"),
  /** Сколько раз в сутки один человек может искать людей (защита от выкачивания базы). */
  POISK_DAILY_LIMIT: num(z.coerce.number().int().nonnegative().catch(30)),
  /**
   * Файл «ФИО;телеграм-ник» — по нему бот здоровается по имени. Лежит ТОЛЬКО
   * на хостинге, как и реестр поиска, и в поиск студентов не попадает: ники
   * читает отдельный модуль (src/students/known.ts), поиску они не видны.
   * Пустое значение или отсутствующий файл = бот никого не узнаёт.
   */
  KNOWN_DB: z.string().default("./data/known.csv"),
  /**
   * Реестр преподавателей для режима преподавателя: «ФИО;телеграм-ник», как у
   * KNOWN_DB. Лежит только на хостинге. Преподаватель из реестра включает режим
   * командой /prepod, и бот показывает его собственное расписание как «свою группу».
   */
  TEACHERS_DB: z.string().default("./data/teachers.csv"),
  /**
   * Болталка в групповых чатах: бота позвали (@бот привет или ответ на его
   * сообщение) — он отвечает через Claude с учётом разговора. Включена по
   * умолчанию (нужен ключ Anthropic); болтает только в разрешённых чатах.
   * FALSE — бот в группах молчит.
   */
  CHAT_AI: z
    .string()
    .default("TRUE")
    .transform((v) => ["1", "true", "yes", "on", "да"].includes(v.trim().toLowerCase())),
  /** Отдельный ключ Anthropic для болталки (свой счёт и свои лимиты). Пусто — берётся ANTHROPIC_API_KEY. */
  CHAT_ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /** Модель болталки. Пусто — та же, что AI_MODEL. */
  CHAT_AI_MODEL: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /**
   * База «вопрос;ответ» — сценарий для болталки: на похожий вопрос бот отвечает
   * заготовкой (своими словами или дословно). Лежит на хостинге, в репозиторий
   * не попадает; бот перечитывает файл сам, перезапуск не нужен.
   */
  CHAT_QA_DB: z.string().default("./data/chat-qa.csv"),
  /** Дневные лимиты по умолчанию; в админке («💬 Болталка») их можно поменять без перезапуска. */
  CHAT_DAILY_LIMIT_PER_USER: num(z.coerce.number().int().nonnegative().catch(20)),
  CHAT_DAILY_LIMIT_PER_CHAT: num(z.coerce.number().int().nonnegative().catch(150)),
  CHAT_DAILY_LIMIT_GLOBAL: num(z.coerce.number().int().nonnegative().catch(400)),
  /**
   * Чаты, где болталка включена сразу. Остальные включаются в админке; чат,
   * куда бота добавил сам админ бота, включается автоматически.
   */
  CHAT_GROUP_IDS: idList,
  /** Сколько последних сообщений чата бот держит в памяти как контекст (0 — только свои диалоги). */
  CHAT_CONTEXT_MESSAGES: num(z.coerce.number().int().min(0).max(100).catch(30)),
  /** Токен, которым сервер записи вебинаров подписывает загрузку слайдов (POST /slides). Пусто — приём выключен. */
  SLIDES_TOKEN: z.string().optional().transform((v) => (v && v.trim().length >= 16 ? v.trim() : undefined)),
  SLIDES_DIR: z.string().default("./data/slides"),
  PORTAL_TLS_INSECURE: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  LOG_LEVEL: z.string().default("info").transform(logLevel),
  /** Poster look: midnight (default), editorial, brutalist, timeline. */
  POSTER_THEME: z.string().default("midnight"),
  HTTPS_PROXY: z.string().optional(),
  /**
   * Port of the tiny HTTP server (calendar subscriptions, /health). Pterodactyl
   * passes SERVER_PORT. 0 = off. A junk value disables the server instead of
   * stopping the bot from starting.
   */
  HTTP_PORT: num(z.coerce.number().int().min(0).max(65535).catch(0)),
  SERVER_PORT: num(z.coerce.number().int().min(0).max(65535).catch(0)).optional(),
  /** Public base URL of that server, e.g. http://srv3.frienworld.space:40070 — enables calendar subscription links. */
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => {
      const raw = v?.trim().replace(/\/+$/, "");
      if (!raw) return undefined;
      // A missing scheme is a typo worth fixing, not a reason to refuse to start.
      const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      return /^https?:\/\/[^\s/]+$/i.test(url.replace(/\/.*$/, (m) => (m === "/" ? "" : m))) || /^https?:\/\/\S+$/i.test(url) ? url : undefined;
    }),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
