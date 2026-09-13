import type { LocalDate } from "../time.js";
import { addDays, mondayOf, weekdayOf, WEEKDAY_NAMES } from "../time.js";
import type { Occurrence, Period } from "./model.js";
import type { SourcedDay, SourcedLesson } from "./merge.js";

export interface ExpandOptions {
  groupKey: string;
  period: Period;
  /** Monday of academic week 1 (calibrated from the portal's "идет N неделя"). */
  weekOneMonday: LocalDate;
  /** Number of academic weeks in the semester. */
  weekCount?: number;
  from: LocalDate;
  to: LocalDate;
}

const WEEKDAY_INDEX = new Map<string, number>(WEEKDAY_NAMES.map((n, i) => [n.toLowerCase(), i]));

/** Non-working public holidays (Art. 112 of the Russian Labour Code). */
const HOLIDAYS_MMDD = new Set(["01-01", "01-02", "01-03", "01-04", "01-05", "01-06", "01-07", "01-08", "02-23", "03-08", "05-01", "05-09", "06-12", "11-04"]);

export function isPublicHoliday(date: LocalDate): boolean {
  return HOLIDAYS_MMDD.has(date.slice(5));
}

function minutes(t: { hours: number; minutes: number } | undefined): number | null {
  return t ? t.hours * 60 + t.minutes : null;
}

function teacherName(l: SourcedLesson): string | null {
  const n = l.teacher?.name?.trim();
  if (!n || n === "---" || n === "-") return null;
  return n;
}

export function weeksHint(l: SourcedLesson): string | undefined {
  const parts: string[] = [];
  if (l.weeks) parts.push(l.weeks.from === l.weeks.to ? `${l.weeks.from} нед.` : `${l.weeks.from}–${l.weeks.to} нед.`);
  if (l.weekParity) parts.push(l.weekParity === "odd" ? "нечётные" : "чётные");
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * Turn the portal's weekday grid (semester) or dated rows (session) into
 * concrete dated occurrences within [from, to].
 */
export function expandDays(days: SourcedDay[], opts: ExpandOptions): Occurrence[] {
  const out: Occurrence[] = [];
  const weekCount = opts.weekCount ?? 17;

  // Pass 1: regular rows.
  for (const day of days) {
    if (day.date) {
      // Session layout: rows already carry a date.
      if (day.date < opts.from || day.date > opts.to) continue;
      for (const block of day.blocks) {
        for (const lesson of block.lessons) {
          out.push(makeOccurrence(lesson, day.date, block, opts));
        }
      }
      continue;
    }
    const weekday = WEEKDAY_INDEX.get(day.weekday.trim().toLowerCase());
    if (!weekday) continue;
    if (day.isSelfStudyDay) continue;
    for (const block of day.blocks) {
      for (const lesson of block.lessons) {
        if (lesson.transfer) continue; // handled in pass 2
        const range = lesson.weeks ?? { from: 1, to: weekCount };
        for (let w = Math.max(1, range.from); w <= Math.min(weekCount, range.to); w++) {
          if (lesson.weekParity === "odd" && w % 2 === 0) continue;
          if (lesson.weekParity === "even" && w % 2 === 1) continue;
          const date = addDays(opts.weekOneMonday, (w - 1) * 7 + (weekday - 1));
          if (date < opts.from || date > opts.to) continue;
          if (isPublicHoliday(date)) continue;
          const occ = makeOccurrence(lesson, date, block, opts);
          const sub = lesson.substitutions?.find((s) => s.date === date);
          if (sub) {
            occ.substituted = { room: occ.room, teacher: occ.teacher, distance: occ.isDistance };
            if (sub.room) occ.room = sub.room;
            if (sub.teacher?.name && sub.teacher.name !== "---") occ.teacher = sub.teacher.name;
            if (sub.isDistance) occ.isDistance = true;
          }
          out.push(occ);
        }
      }
    }
  }

  // Pass 2: transfers. The entry lives in the *target* cell and names the origin.
  for (const day of days) {
    if (day.date) continue;
    for (const block of day.blocks) {
      for (const lesson of block.lessons) {
        const t = lesson.transfer;
        if (!t) continue;
        // Vacate the origin (if it falls into our window and exists).
        const origin = out.find(
          (o) =>
            o.date === t.fromDate &&
            o.slot === t.fromSlot &&
            o.subject === lesson.subject &&
            (lesson.subgroup == null || o.subgroup == null || o.subgroup === lesson.subgroup) &&
            o.status === "scheduled",
        );
        if (origin) {
          origin.status = "moved";
          origin.movedTo = { date: t.targetDate, slot: block.slotNumber ?? null };
        }
        if (t.targetDate < opts.from || t.targetDate > opts.to) continue;
        const occ = makeOccurrence(lesson, t.targetDate, block, opts);
        occ.movedFrom = { date: t.fromDate, slot: t.fromSlot };
        occ.weeksHint = undefined;
        out.push(occ);
      }
    }
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || (a.slot ?? 0) - (b.slot ?? 0) || (a.subgroup ?? 0) - (b.subgroup ?? 0));
  return out;
}

function makeOccurrence(lesson: SourcedLesson, date: LocalDate, block: SourcedDay["blocks"][number], opts: ExpandOptions): Occurrence {
  return {
    groupKey: opts.groupKey,
    period: opts.period,
    date,
    slot: block.slotNumber ?? null,
    start: minutes(block.time?.start),
    end: minutes(block.time?.end),
    subject: lesson.subject.trim(),
    type: lesson.type.replace(/\.$/, "").toLowerCase(),
    room: lesson.room?.trim() || null,
    teacher: teacherName(lesson),
    subgroup: lesson.subgroup ?? null,
    isDistance: !!lesson.isDistance,
    status: "scheduled",
    sources: [...lesson.sources],
    weeksHint: weeksHint(lesson),
  };
}

/** Academic week number of a date given the calibrated anchor (1-based; may be <= 0 before the semester). */
export function academicWeek(date: LocalDate, weekOneMonday: LocalDate): number {
  const diff = (Number(new Date(mondayOf(date)).getTime() - new Date(weekOneMonday).getTime()) / 86_400_000) | 0;
  return Math.floor(diff / 7) + 1;
}

export function weekdayIndex(date: LocalDate): number {
  return weekdayOf(date);
}
