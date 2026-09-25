import pino from "pino";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/** Уровень логов: пустое или незнакомое значение — info (pino на них падает при старте). */
export function logLevel(raw: string | undefined): string {
  const v = raw?.trim().toLowerCase() ?? "";
  return LEVELS.has(v) ? v : "info";
}

/**
 * Секреты, которые могут прийти в лог внутри ошибок: сетевая ошибка grammY
 * несёт URL api.telegram.org/bot<токен>/…, ошибка SDK — ключ Anthropic.
 */
const SECRETS: Array<[RegExp, string]> = [
  [/\d{5,}:[A-Za-z0-9_-]{30,}/g, "<bot-token>"],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "<anthropic-key>"],
];

/** Вычищает секреты из всего, что уходит в лог; ошибки разворачивает, не теряя message и stack. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return SECRETS.reduce((s, [re, to]) => s.replace(re, to), value);
  if (!value || typeof value !== "object" || depth > 6) return value;
  if (value instanceof Error) return scrubSecrets(pino.stdSerializers.err(value), depth + 1);
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v, depth + 1);
  return out;
}

export const logger = pino({
  level: logLevel(process.env.LOG_LEVEL),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { log: (obj) => scrubSecrets(obj) as Record<string, unknown> },
  // Ошибки уже развёрнуты выше; повторная обработка стёрла бы их тип («HttpError» → «Object»).
  serializers: { err: (e: unknown) => (e instanceof Error ? scrubSecrets(e) : e) },
});

export type Logger = typeof logger;
