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
  DB_PATH: z.string().default("./data/vish-bot.sqlite"),
  POLL_CRON_BUSY: z.string().default("*/5 7-21 * * 1-6"),
  POLL_CRON_IDLE: z.string().default("*/30 * * * *"),
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  AI_MODEL: z.string().default("claude-opus-5"),
  AI_DAILY_LIMIT_PER_USER: z.coerce.number().int().nonnegative().default(10),
  AI_DAILY_LIMIT_GLOBAL: z.coerce.number().int().nonnegative().default(300),
  PORTAL_TLS_INSECURE: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  LOG_LEVEL: z.string().default("info"),
  HTTPS_PROXY: z.string().optional(),
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
