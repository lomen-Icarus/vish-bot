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
import { buildIcs } from "./ics.js";
import { addDays, todayMsk, type LocalDate } from "../time.js";

/** Semester end (plus session tail) capped at 150 days ahead. */
export function calendarWindow(service: ScheduleService, today: LocalDate = todayMsk()): { from: LocalDate; to: LocalDate } {
  const anchor = service.weekOneMonday(service.semesterFor(today));
  const semesterEnd = anchor ? addDays(anchor, SEMESTER_WEEKS * 7 + 21) : addDays(today, 120);
  const cap = addDays(today, 150);
  return { from: today, to: semesterEnd < cap ? semesterEnd : cap };
}

export interface GroupCalendar {
  ics: string;
  count: number;
  from: LocalDate;
  to: LocalDate;
}

/** Full calendar of a group from today to the end of the semester. */
export function groupCalendar(service: ScheduleService, group: LogicalGroup, opts: { subgroup: number | null; alarmMinutes: number | null; now?: Date; refreshInterval?: string; today?: LocalDate }): GroupCalendar {
  const { from, to } = calendarWindow(service, opts.today);
  const lessons = filterSubgroup(service.materialize(group, from, to), opts.subgroup);
  const ics = buildIcs({ name: group.title, lessons, alarmMinutes: opts.alarmMinutes, now: opts.now, refreshInterval: opts.refreshInterval });
  return { ics, count: lessons.filter((o) => o.status === "scheduled").length, from, to };
}

/**
 * Only the lessons touched by change events: new/updated ones as live
 * events, removed/moved-away ones as cancelled. Re-importing this file
 * fixes exactly those events in a calendar that already has the full export.
 */
export function changesCalendar(group: LogicalGroup, events: ChangeEvent[], opts: { subgroup: number | null; alarmMinutes: number | null; now?: Date }): { ics: string; live: number; cancelled: number } {
  const live: Occurrence[] = [];
  const cancelled: Occurrence[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "added":
        if (e.after) live.push(e.after);
        break;
      case "removed":
        if (e.before) cancelled.push(e.before);
        break;
      case "changed":
        if (e.after) (e.after.status === "moved" ? cancelled : live).push(e.after);
        break;
      case "moved":
        if (e.before) cancelled.push(e.before);
        if (e.after) live.push(e.after);
        break;
    }
  }
  const liveF = filterSubgroup(live, opts.subgroup);
  const cancelledF = filterSubgroup(cancelled, opts.subgroup);
  const ics = buildIcs({ name: group.title, lessons: liveF, cancelled: cancelledF, alarmMinutes: opts.alarmMinutes, now: opts.now });
  return { ics, live: liveF.filter((o) => o.status === "scheduled").length, cancelled: cancelledF.length + liveF.filter((o) => o.status === "moved").length };
}
