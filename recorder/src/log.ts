/** Логи в stdout одной строкой JSON — панель Pterodactyl показывает их как есть. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = (): number => ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, obj: unknown, msg?: string): void {
  if (ORDER[level] < threshold()) return;
  const payload = typeof obj === "string" ? { msg: obj } : { ...(obj as object), msg };
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, ...payload })}\n`);
}

export const log = {
  debug: (obj: unknown, msg?: string) => emit("debug", obj, msg),
  info: (obj: unknown, msg?: string) => emit("info", obj, msg),
  warn: (obj: unknown, msg?: string) => emit("warn", obj, msg),
  error: (obj: unknown, msg?: string) => emit("error", obj, msg),
};

/**
 * Ошибка для лога без путей: в тексте ошибки файла — путь к папке пары, а в
 * нём фамилия преподавателя, хвост же лога печатается в публичный лог деплоя.
 * Путь — только с начала слова или в кавычках: «Мат/анализ» и адреса не трогаем.
 * Код ошибки — только строковый (ENOSPC); у DOMException он числовой — там имя
 * (TimeoutError). Код уже в начале текста — второй раз не пишем.
 */
export function errName(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  const text = String(e?.message ?? err)
    .replace(/'\/[^']*'/g, "'<путь>'")
    .replace(/"\/[^"]*"/g, '"<путь>"')
    .replace(/(^|[\s(=])\/[^\s'"),]*/g, "$1<путь>")
    .slice(0, 200);
  const kind = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "Error";
  return text.startsWith(kind) ? text : `${kind}: ${text}`;
}
