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
