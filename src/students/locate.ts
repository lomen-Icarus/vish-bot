/**
 * Где студент должен быть по расписанию. Отдельный модуль, потому что этим
 * пользуются двое: экран «Где студент» и инструмент ИИ-поиска.
 */
import { esc } from "../schedule/format.js";
import { findGroup, logicalKeyFor, type LogicalGroup } from "../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../schedule/model.js";
import { fmtDDMM, fmtHHMM, wallClock, type LocalDate } from "../time.js";
import type { StudentRecord } from "./directory.js";

/**
 * Группа человека в расписании ВИШ. Реестр пишет её по-своему («ВИШ-11-23(ЭиЭА)»,
 * «ВИШ-12-23иот (11.03.04)»), поэтому сначала сравниваем логические ключи.
 * Если под одним номером в расписании несколько РАЗНЫХ групп (ВИШ-11-23 бывает
 * и ЭиЭА, и РЗиАЭС), угадывать нельзя: покажем чужие пары, и никто не заметит.
 */
export function resolveStudentGroup(groups: LogicalGroup[], student: StudentRecord): { group: LogicalGroup | null; ambiguous: LogicalGroup[] } {
  const exact = groups.find((g) => g.key === logicalKeyFor(student.groupTitle));
  if (exact) return { group: exact, ambiguous: [] };
  const list = findGroup(groups, student.groupTitle);
  return list.length === 1 ? { group: list[0]!, ambiguous: [] } : { group: null, ambiguous: list };
}

const place = (o: Occurrence): string => (o.isDistance ? "дистанционно 💻" : o.room ? `ауд. ${esc(o.room)}` : "аудитория не указана");

/** Пара одной строкой; подгруппу называем, когда она неизвестна и вариантов несколько. */
function lessonLine(o: Occurrence, showSubgroup: boolean): string {
  const sub = showSubgroup && o.subgroup ? `${o.subgroup} подгр. — ` : "";
  return `${sub}<b>${esc(o.subject)}</b> (${lessonTypeLabel(o.type)}), ${place(o)}`;
}

/**
 * Где человек должен быть сейчас: идёт пара, перерыв до следующей или свободен.
 * Если в реестре нет подгруппы, у одной и той же пары бывает два разных места —
 * тогда честно показываем оба варианта, а не первый попавшийся.
 */
export function whereNowText(lessons: Occurrence[], date: LocalDate, today: LocalDate, subgroup: number | null): string {
  const clock = wallClock();
  // «moved» — это опустевший слот перенесённой пары, человека там нет.
  const live = lessons.filter((o) => o.status !== "moved");
  const unknownSubgroup = subgroup == null;
  const slots = (list: Occurrence[]): number => new Set(list.map((o) => o.slot ?? o.start ?? 0)).size;
  if (date !== today) {
    if (!live.length) return `📍 ${fmtDDMM(date)}: пар нет.`;
    const n = slots(live);
    const first = live[0]!;
    return `📍 ${fmtDDMM(date)}: ${n} пар${n === 1 ? "а" : n < 5 ? "ы" : ""}, начало в ${first.start != null ? fmtHHMM(first.start) : "?"}.`;
  }
  if (!live.length) return "📍 Сегодня пар нет — по расписанию человек свободен.";
  const now = clock.minutes;
  const sameSlot = (a: Occurrence, b: Occurrence): boolean => (a.slot ?? a.start) === (b.slot ?? b.start);
  const current = live.filter((o) => o.start != null && o.end != null && now >= o.start && now <= o.end);
  const note = unknownSubgroup && current.length > 1 ? "\n<i>Подгруппа в реестре не указана, поэтому оба варианта.</i>" : "";
  if (current.length) {
    const end = current[0]!.end;
    const where = current.map((o) => lessonLine(o, unknownSubgroup)).join("\n   ");
    return `📍 Сейчас (${fmtHHMM(now)}) должен быть здесь: ${current.length > 1 ? "\n   " : ""}${where}${end != null ? `\n   до ${fmtHHMM(end)}` : ""}${note}`;
  }
  const upcoming = live.filter((o) => o.start != null && o.start > now);
  if (upcoming.length) {
    const next = upcoming.filter((o) => sameSlot(o, upcoming[0]!));
    const wait = upcoming[0]!.start! - now;
    const where = next.map((o) => lessonLine(o, unknownSubgroup)).join("\n   ");
    const many = unknownSubgroup && next.length > 1 ? "\n<i>Подгруппа в реестре не указана, поэтому оба варианта.</i>" : "";
    return `📍 Сейчас (${fmtHHMM(now)}) пары нет. Ближайшая через ${wait < 60 ? `${wait} мин` : `${Math.round(wait / 60)} ч`} — в ${fmtHHMM(upcoming[0]!.start!)}: ${next.length > 1 ? "\n   " : ""}${where}${many}`;
  }
  const last = live[live.length - 1]!;
  return `📍 Сейчас (${fmtHHMM(now)}) пар уже нет: на сегодня закончились${last.end != null ? ` в ${fmtHHMM(last.end)}` : ""}.`;
}

