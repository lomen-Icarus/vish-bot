import { createHash } from "node:crypto";
import type { LocalDate } from "../time.js";

export type Period = 1 | 2 | 3 | 4;
export const PERIOD_NAMES: Record<Period, string> = {
  1: "осенний семестр",
  2: "зимняя сессия",
  3: "весенний семестр",
  4: "летняя сессия",
};
export const isSessionPeriod = (p: Period): boolean => p === 2 || p === 4;

export type OccurrenceStatus = "scheduled" | "moved";

export interface Occurrence {
  groupKey: string;
  period: Period;
  date: LocalDate;
  /** Portal slot number ("N пара"); null for session rows without one. */
  slot: number | null;
  /** Minutes since local midnight. */
  start: number | null;
  end: number | null;
  subject: string;
  /** Raw portal type: лк, пр, лб, зач, зачо, экз, конс, ... */
  type: string;
  room: string | null;
  teacher: string | null;
  subgroup: number | null;
  isDistance: boolean;
  /** "moved" marks the vacated original slot of a transferred lesson. */
  status: OccurrenceStatus;
  movedTo?: { date: LocalDate; slot: number | null };
  movedFrom?: { date: LocalDate; slot: number };
  /** Date-specific substitution that was applied (original values kept here). */
  substituted?: { room?: string | null; teacher?: string | null; distance?: boolean };
  /** Portal group names this lesson was observed in (merged logical groups). */
  sources: string[];
  /** Groups attending, when the source page lists them (teacher pages). */
  groups?: string[];
  /** Human hint like "2–16 нед., нечётные" (semester rows only). */
  weeksHint?: string;
}

/** Identity of a lesson inside one day: what "the same lesson" means for diffing. */
export function positionKey(o: Pick<Occurrence, "date" | "slot" | "start" | "subject" | "type" | "subgroup">): string {
  return [o.date, o.slot ?? `t${o.start ?? ""}`, o.subject, o.type, o.subgroup ?? ""].join("|");
}

/** Hash of everything a student cares about; used to detect edits in place. */
export function contentHash(o: Occurrence): string {
  const payload = [
    o.slot,
    o.start,
    o.end,
    o.subject,
    o.type,
    o.room,
    o.teacher,
    o.subgroup,
    o.isDistance ? 1 : 0,
    o.status,
    o.movedTo?.date,
    o.movedTo?.slot,
    o.movedFrom?.date,
    o.movedFrom?.slot,
  ].join("~|~");
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

export const LESSON_TYPE_LABELS: Record<string, string> = {
  лк: "лекция",
  пр: "практика",
  лб: "лабораторная",
  зач: "зачёт",
  зачо: "зачёт с оценкой",
  экз: "экзамен",
  конс: "консультация",
  кп: "курсовой проект",
  крп: "курсовая работа",
  из: "инд. занятие",
  гз: "групповое занятие",
};

export function lessonTypeLabel(type: string): string {
  const key = type.replace(/\.$/, "").toLowerCase();
  return LESSON_TYPE_LABELS[key] ?? type;
}

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}
