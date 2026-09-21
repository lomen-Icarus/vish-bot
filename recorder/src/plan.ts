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
