/**
 * Пересдачи (ППА): что считать одной пересдачей, волной и её изменением.
 * Страницы забирает ScheduleService.pollPpa, показывает src/bot/handlers/ppa.ts.
 */
import type { PpaItem } from "../portal/ppa.js";
import type { LocalDate } from "../time.js";
import type { Occurrence, Period } from "./model.js";
import { subjectKey } from "./subjects.js";

export interface PpaEvent {
  groupKey: string;
  subjectKey: string;
  change: "added" | "removed" | "changed";
  before: PpaItem | null;
  after: PpaItem | null;
}

/** Одна пересдача: предмет, форма и попытка («Базы данных», КП и экзамен — разные). */
const itemKey = (i: PpaItem): string => `${subjectKey(i.subject)}|${i.kind.toLowerCase()}|${i.attempt ?? 0}`;

/** Пересдачи нескольких страниц одной группы (основная и «иот») без повторов, по порядку. */
export function mergePpa(pages: PpaItem[][]): PpaItem[] {
  const seen = new Set<string>();
  const out: PpaItem[] = [];
  for (const i of pages.flat()) {
    const k = `${i.date}|${i.start ?? ""}|${itemKey(i)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || a.subject.localeCompare(b.subject, "ru"));
}

/**
 * Волна ППА — после зимней сессии (весна) или летней (осень). По ней бот
 * спрашивает про долги один раз и сбрасывает прошлые отметки.
 */
export function ppaWave(items: PpaItem[]): string | null {
  if (!items.length) return null;
  const last = items.reduce((a, b) => (b.date > a ? b.date : a), items[0]!.date);
  const month = Number(last.slice(5, 7));
  return `${last.slice(0, 4)}-${month >= 8 ? "осень" : "весна"}`;
}

/**
 * Что поменялось в пересдачах группы — только то, что ещё впереди: прошедшая
 * пересдача, пропавшая со страницы, никому не интересна.
 */
export function diffPpa(groupKey: string, prev: PpaItem[], next: PpaItem[], today: LocalDate): PpaEvent[] {
  const byKey = (list: PpaItem[]): Map<string, PpaItem> => new Map(list.map((i) => [itemKey(i), i]));
  const a = byKey(prev);
  const b = byKey(next);
  const out: PpaEvent[] = [];
  for (const [k, after] of b) {
    const before = a.get(k);
    const key = subjectKey(after.subject);
    if (!before) {
      if (after.date >= today) out.push({ groupKey, subjectKey: key, change: "added", before: null, after });
      continue;
    }
    const moved = before.date !== after.date || before.start !== after.start || before.end !== after.end || before.room !== after.room;
    if (moved && (before.date >= today || after.date >= today)) out.push({ groupKey, subjectKey: key, change: "changed", before, after });
  }
  for (const [k, before] of a) {
    if (!b.has(k) && before.date >= today) out.push({ groupKey, subjectKey: subjectKey(before.subject), change: "removed", before, after: null });
  }
  return out;
}

/** Пересдача как пара расписания — чтобы встать в день, неделю, напоминания и календарь. */
export function ppaOccurrence(groupKey: string, i: PpaItem, period: Period): Occurrence {
  return {
    groupKey,
    period,
    date: i.date,
    slot: null,
    start: i.start,
    end: i.end,
    subject: i.subject,
    type: i.kind.toLowerCase(),
    room: i.room,
    teacher: null,
    subgroup: null,
    isDistance: i.isDistance,
    status: "scheduled",
    sources: [],
    ppa: i.attempt ?? 0,
  };
}
