/**
 * Общие мелочи планировщика: время по Москве и фильтр «эту пару записываем».
 * Отдельный модуль, чтобы разведка (probe) могла ими пользоваться, не запуская
 * при импорте боевой цикл записи.
 */
import type { RecorderConfig } from "./config.js";
import type { WebinarRow } from "./portal.js";

/** Московская дата и минуты с полуночи: расписание живёт в этом часовом поясе. */
export function mskNow(at = new Date()): { date: string; minutes: number } {
  const shifted = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  return { date: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export const norm = (s: string): string => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/** Подходит ли эта пара под фильтры записи. */
export function wanted(row: WebinarRow, cfg: Pick<RecorderConfig, "subjects" | "groups">): boolean {
  // Вне расписания бывают закрытые встречи — их записывать нельзя.
  if (!row.scheduled) return false;
  if (!row.groups.length) return false;
  if (cfg.subjects.length && !cfg.subjects.some((s) => norm(row.subject).includes(norm(s)))) return false;
  if (cfg.groups.length && !cfg.groups.some((g) => row.groups.some((rg) => norm(rg).includes(norm(g))))) return false;
  return true;
}

/** Ключ, по которому понимаем, что эту пару мы уже записали сегодня. */
export const keyOf = (date: string, row: WebinarRow): string => `${date}|${row.startMinutes ?? "?"}|${norm(row.subject)}|${norm(row.teacher)}`;

/** Что планировщик помнит о сегодняшних парах. */
export interface RecordState {
  /** Записаны (или точно больше не нужны). */
  done: Set<string>;
  /** Записываются прямо сейчас. */
  active: Set<string>;
  /** Не получилось — когда пробовать снова (мс). */
  retryAt: Map<string, number>;
}

export interface DuePlan {
  /** Начать запись сейчас. */
  start: WebinarRow[];
  /** Пара скоро или идёт, но кнопки «Подключиться» ещё нет (или ждём повтора). */
  waiting: WebinarRow[];
  /** Готовы, но все места для одновременной записи заняты. */
  skipped: WebinarRow[];
}

/**
 * Какие пары записывать сейчас. Пара «в работе» с момента «за leadMinutes до
 * начала» и до её конца: пока она идёт, неудачная попытка (комнату ещё не
 * открыли, бот не зашёл, ни одного слайда) повторяется — раньше после трёх
 * осечек за первые минуты пара терялась целиком.
 */
export function planRecording(
  rows: WebinarRow[],
  now: { date: string; minutes: number },
  cfg: Pick<RecorderConfig, "subjects" | "groups" | "leadMinutes" | "maxParallel">,
  state: RecordState,
  nowMs: number,
): DuePlan {
  const inWindow = rows.filter((r) => wanted(r, cfg) && r.startMinutes != null && now.minutes >= r.startMinutes - cfg.leadMinutes && (r.endMinutes == null || now.minutes < r.endMinutes));
  const open = inWindow.filter((r) => {
    const key = keyOf(now.date, r);
    return !state.done.has(key) && !state.active.has(key);
  });
  const ready = open.filter((r) => r.joinId && (state.retryAt.get(keyOf(now.date, r)) ?? 0) <= nowMs).sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0));
  const free = Math.max(0, cfg.maxParallel - state.active.size);
  return { start: ready.slice(0, free), skipped: ready.slice(free), waiting: open.filter((r) => !ready.includes(r)) };
}

/** Имя файла без опасных символов: предмет, дата и время начала — у двух пар одного предмета в день разные файлы. */
export function deckBaseName(date: string, startMinutes: number | null, subject: string): string {
  const hhmm = startMinutes != null ? `${String(Math.floor(startMinutes / 60)).padStart(2, "0")}${String(startMinutes % 60).padStart(2, "0")}` : "xxxx";
  const safe = subject.replace(/[^\p{L}\p{N} .-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 50) || "вебинар";
  return `${date}-${hhmm}-${safe}`.replace(/[/\\]/g, "-");
}
