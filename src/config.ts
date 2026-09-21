import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

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

const schema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN is required"),
  ADMIN_IDS: idList,
  MEDIA_CHAT_IDS: idList,
  FACULTY_ID: z.coerce.number().int().positive().default(32),
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
  NEWS_LOOKBACK_HOURS: z.coerce.number().int().positive().default(32),
  NEWS_MAX_PER_TOPIC: z.coerce.number().int().positive().default(8),
  DB_PATH: z.string().default("./data/vish-bot.sqlite"),
  POLL_CRON_BUSY: z.string().default("*/6 7-21 * * 1-6"),
  POLL_CRON_IDLE: z.string().default("*/30 * * * *"),
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  AI_MODEL: z.string().default("claude-sonnet-5"),
  AI_DAILY_LIMIT_PER_USER: z.coerce.number().int().nonnegative().default(10),
  AI_DAILY_LIMIT_GLOBAL: z.coerce.number().int().nonnegative().default(300),
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
  POISK_DAILY_LIMIT: z.coerce.number().int().nonnegative().catch(30),
  /** Токен, которым сервер записи вебинаров подписывает загрузку слайдов (POST /slides). Пусто — приём выключен. */
  SLIDES_TOKEN: z.string().optional().transform((v) => (v && v.trim().length >= 16 ? v.trim() : undefined)),
  SLIDES_DIR: z.string().default("./data/slides"),
  PORTAL_TLS_INSECURE: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  LOG_LEVEL: z.string().default("info"),
  /** Poster look: midnight (default), editorial, brutalist, timeline. */
  POSTER_THEME: z.string().default("midnight"),
  HTTPS_PROXY: z.string().optional(),
  /**
   * Port of the tiny HTTP server (calendar subscriptions, /health). Pterodactyl
   * passes SERVER_PORT. 0 = off. A junk value disables the server instead of
   * stopping the bot from starting.
   */
  HTTP_PORT: z.coerce.number().int().min(0).max(65535).catch(0),
  SERVER_PORT: z.coerce.number().int().min(0).max(65535).catch(0).optional(),
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
