/**
 * Calendar feeds: what goes into a user's .ics (file or subscription) and
 * into the "just the changes" file offered under «Изменения».
 */
import type { ScheduleService } from "./service.js";
import { SEMESTER_WEEKS } from "./service.js";
import type { LogicalGroup } from "./groups.js";
import type { Occurrence } from "./model.js";
import type { ChangeEvent } from "./diff.js";
import { filterSubgroup } from "./format.js";
import { buildIcs, icsUid } from "./ics.js";
import { addDays, todayMsk, type LocalDate } from "../time.js";

/**
 * Конец семестра вместе с сессией, но не дальше 150 дней вперёд. Хвост — семь
 * недель: зимние экзамены идут до конца января (раньше окно кончалось 18.01,
 * и экзамены 20–23.01 в календарь не попадали). И не короче 45 дней от
 * сегодня: после конца окна подписанный календарь иначе пустел и стирал
 * оставшиеся экзамены.
 */
export function calendarWindow(service: ScheduleService, today: LocalDate = todayMsk(), pastDays = 0): { from: LocalDate; to: LocalDate } {
  const anchor = service.weekOneMonday(service.semesterFor(today));
  const semesterEnd = anchor ? addDays(anchor, SEMESTER_WEEKS * 7 + 49) : addDays(today, 120);
  const floor = addDays(today, 45);
  const cap = addDays(today, 150);
  const end = semesterEnd > floor ? semesterEnd : floor;
  return { from: addDays(today, -pastDays), to: end < cap ? end : cap };
}

/**
 * Сколько дней прошлого держат ленты-подписки. Пара, пропавшая из ленты,
 * удаляется из подписанного календаря, и раньше вчерашние пары исчезали
 * каждый день. 180 дней — прошлый семестр с сессией; бесконечно не держим:
 * лента росла бы год от года. Прошлое собирается из сохранённых страниц
 * портала, а они и неделя 1 привязаны к учебному году: со сменой года
 * весенние пары (кроме сессии) из ленты уходят раньше 180 дней. Файл .ics —
 * разовый, ему прошлое не нужно.
 */
export const FEED_PAST_DAYS = 180;

export interface GroupCalendar {
  ics: string;
  count: number;
  from: LocalDate;
  to: LocalDate;
}

/**
 * Пары группы для календаря человека: своя подгруппа и отмеченные пересдачи
 * (ППА); allPpa — все пересдачи группы (календарь группы от админа, /calfeeds).
 * Общее у ленты-подписки, файла .ics и прямой записи в Google.
 */
export function calendarLessons(service: ScheduleService, group: LogicalGroup, opts: { subgroup: number | null; today?: LocalDate; ppaDebts?: string[]; allPpa?: boolean; pastDays?: number }): { lessons: Occurrence[]; from: LocalDate; to: LocalDate } {
  const { from, to } = calendarWindow(service, opts.today, opts.pastDays);
  const ppa = opts.allPpa ? service.ppaLessons(group, "all", from, to) : opts.ppaDebts?.length ? service.ppaLessons(group, opts.ppaDebts, from, to) : [];
  const own = filterSubgroup(service.materialize(group, from, to), opts.subgroup);
  const lessons = ppa.length ? [...own, ...ppa].sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0)) : own;
  return { lessons, from, to };
}

/** Full calendar of a group from today to the end of the semester. */
export function groupCalendar(service: ScheduleService, group: LogicalGroup, opts: { subgroup: number | null; alarmMinutes: number | null; now?: Date; refreshInterval?: string; stableSequence?: boolean; today?: LocalDate; ppaDebts?: string[]; allPpa?: boolean; uidScope?: string; pastDays?: number }): GroupCalendar {
  const { lessons, from, to } = calendarLessons(service, group, opts);
  const ics = buildIcs({ name: group.title, lessons, alarmMinutes: opts.alarmMinutes, now: opts.now, refreshInterval: opts.refreshInterval, stableSequence: opts.stableSequence, uidScope: opts.uidScope });
  return { ics, count: lessons.filter((o) => o.status === "scheduled").length, from, to };
}

/**
 * Only the lessons touched by change events: new/updated ones as live
 * events, removed/moved-away ones as cancelled. Re-importing this file
 * fixes exactly those events in a calendar that already has the full export.
 */
export function changesCalendar(group: LogicalGroup, events: ChangeEvent[], opts: { subgroup: number | null; alarmMinutes: number | null; now?: Date }): { ics: string; live: number; cancelled: number } {
  // Events arrive oldest first. A lesson can change several times (room A → B → C),
  // and a position can even be cancelled and restored, so the newest event for a
  // position is the one that must end up in the file.
  const byUid = new Map<string, { o: Occurrence; cancelled: boolean }>();
  const put = (o: Occurrence | undefined, cancelled: boolean) => {
    if (!o) return;
    byUid.set(icsUid(o), { o, cancelled });
  };
  for (const e of events) {
    switch (e.kind) {
      case "added":
        put(e.after, false);
        break;
      case "removed":
        put(e.before, true);
        break;
      case "changed":
        put(e.after, e.after?.status === "moved");
        break;
      case "moved":
        put(e.before, true);
        put(e.after, false);
        break;
    }
  }
  const live: Occurrence[] = [];
  const cancelled: Occurrence[] = [];
  for (const { o, cancelled: isCancelled } of byUid.values()) (isCancelled ? cancelled : live).push(o);
  const liveF = filterSubgroup(live, opts.subgroup);
  const cancelledF = filterSubgroup(cancelled, opts.subgroup);
  const ics = buildIcs({ name: group.title, lessons: liveF, cancelled: cancelledF, alarmMinutes: opts.alarmMinutes, now: opts.now });
  return { ics, live: liveF.filter((o) => o.status === "scheduled").length, cancelled: cancelledF.length + liveF.filter((o) => o.status === "moved").length };
}
