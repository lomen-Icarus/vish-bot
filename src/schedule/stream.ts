/**
 * "Поток" views: all groups of one intake side by side, with identical lessons
 * (joint lectures) merged into a single row listing the groups that attend.
 */
import type { LogicalGroup } from "./groups.js";
import { lessonTypeLabel, type Occurrence } from "./model.js";
import { esc, parityLine, teacherLabel, type TeacherView } from "./format.js";
import type { WeekInfo } from "./service.js";
import { addDays, fmtDDMM, fmtDayMonth, fmtHHMM, weekdayName, type LocalDate } from "../time.js";

const SLOT_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

export interface StreamRow {
  date: LocalDate;
  slot: number | null;
  start: number | null;
  end: number | null;
  subject: string;
  type: string;
  room: string | null;
  isDistance: boolean;
  subgroup: number | null;
  status: Occurrence["status"];
  /** Кто ведёт: портал называет преподавателя только авторизованным. */
  teacher: string | null;
  /** Short labels of groups attending this exact lesson, in stream order. */
  groups: string[];
  groupKeys: string[];
  /** Smallest group number among attendees; rows inside a slot are ordered by it. */
  minNumber: number;
}

/** "ВИШ-12-23" -> "12-23", "ВИШ-11-23 (ЭиЭА)" -> "11-23 ЭиЭА". */
export function shortGroupLabel(g: LogicalGroup): string {
  return g.title.replace(/^ВИШ-/, "").replace(/\s*\((.*?)\)\s*$/, " $1");
}

function rowKey(o: Occurrence): string {
  return [o.date, o.slot ?? `t${o.start}`, o.subject, o.type, o.room ?? "", o.isDistance ? 1 : 0, o.subgroup ?? "", o.status].join("|");
}

/** Merge per-group occurrences of a stream into rows shared across groups. */
export function mergeStream(groups: LogicalGroup[], byGroup: Map<string, Occurrence[]>): StreamRow[] {
  const rows = new Map<string, StreamRow>();
  for (const g of groups) {
    for (const o of byGroup.get(g.key) ?? []) {
      const key = rowKey(o);
      let row = rows.get(key);
      if (!row) {
        row = { date: o.date, slot: o.slot, start: o.start, end: o.end, subject: o.subject, type: o.type, room: o.room, isDistance: o.isDistance, subgroup: o.subgroup, status: o.status, teacher: o.teacher, groups: [], groupKeys: [], minNumber: g.number };
        rows.set(key, row);
      }
      // Одну и ту же пару портал мог назвать по имени только у одной группы.
      row.teacher ??= o.teacher;
      if (!row.groupKeys.includes(g.key)) {
        row.groups.push(shortGroupLabel(g));
        row.groupKeys.push(g.key);
        row.minNumber = Math.min(row.minNumber, g.number);
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || (a.slot ?? 0) - (b.slot ?? 0) || a.minNumber - b.minNumber || (a.subgroup ?? 0) - (b.subgroup ?? 0) || a.subject.localeCompare(b.subject, "ru"),
  );
}

function rowLine(r: StreamRow, ownKey: string | null, view: TeacherView = "bold"): string {
  const mine = ownKey !== null && r.groupKeys.includes(ownKey);
  const who = r.groups.map((g, i) => (r.groupKeys[i] === ownKey ? `<b>${esc(g)}</b>` : esc(g))).join(", ");
  const where = r.isDistance ? "💻" : r.room ? esc(r.room) : "";
  const subj = r.status === "moved" ? `<s>${esc(r.subject)}</s>` : esc(r.subject);
  const sg = r.subgroup ? ` (${r.subgroup} п.)` : "";
  const who2 = teacherLabel(r.teacher, view);
  return `   ${mine ? "★ " : ""}${who} · ${subj} <i>${lessonTypeLabel(r.type)}</i>${sg}${where ? ` · ${where}` : ""}${who2 ? ` · ${who2}` : ""}`;
}

function slotHeader(r: StreamRow): string {
  const badge = r.slot != null ? (SLOT_EMOJI[r.slot] ?? `${r.slot}.`) : "•";
  const time = r.start != null && r.end != null ? ` <code>${fmtHHMM(r.start)}–${fmtHHMM(r.end)}</code>` : "";
  return `${badge}${time}`;
}

function groupBySlot(rows: StreamRow[]): Array<{ header: string; rows: StreamRow[] }> {
  const out: Array<{ header: string; rows: StreamRow[] }> = [];
  for (const r of rows) {
    const header = slotHeader(r);
    const last = out[out.length - 1];
    if (last && last.header === header) last.rows.push(r);
    else out.push({ header, rows: [r] });
  }
  return out;
}

export function formatStreamDay(intake: number, date: LocalDate, rows: StreamRow[], info: WeekInfo, today: LocalDate, ownKey: string | null, view: TeacherView = "bold"): string {
  const rel = date === today ? "Сегодня · " : date === addDays(today, 1) ? "Завтра · " : date === addDays(today, -1) ? "Вчера · " : "";
  const pl = parityLine(info);
  const head = `<b>Поток 20${intake} · ${rel}${weekdayName(date)}, ${fmtDayMonth(date)}</b>${pl ? `\n${pl}` : ""}`;
  const dayRows = rows.filter((r) => r.date === date);
  if (!dayRows.length) return `${head}\n\n😴 У потока пар нет`;
  const blocks = groupBySlot(dayRows).map((b) => `${b.header}\n${b.rows.map((r) => rowLine(r, ownKey, view)).join("\n")}`);
  return `${head}\n\n${blocks.join("\n\n")}${ownKey ? "\n\n★ — твоя группа" : ""}`;
}

/** Week view split into day chunks; каждый чанк ≤ ~3900 символов. */
export function formatStreamWeek(intake: number, monday: LocalDate, rows: StreamRow[], info: WeekInfo, today: LocalDate, ownKey: string | null, view: TeacherView = "bold"): string[] {
  const pl = parityLine(info);
  const head = `<b>Поток 20${intake} · неделя ${fmtDDMM(monday)} – ${fmtDDMM(addDays(monday, 6))}</b>${pl ? `\n${pl}` : ""}`;
  const chunks: string[] = [];
  let current = head;
  for (let i = 0; i < 6; i++) {
    const date = addDays(monday, i);
    const dayRows = rows.filter((r) => r.date === date);
    const title = `<b>${weekdayName(date)}</b> · <i>${fmtDDMM(date)}${date === today ? " · сегодня" : ""}</i>`;
    const body = dayRows.length ? groupBySlot(dayRows).map((b) => `${b.header}\n${b.rows.map((r) => rowLine(r, ownKey, view)).join("\n")}`).join("\n") : "   — пар нет";
    const section = `\n\n${title}\n${body}`;
    if (current.length + section.length > 3900) {
      chunks.push(current);
      current = section.trimStart();
    } else {
      current += section;
    }
  }
  chunks.push(current);
  return chunks;
}

/** Lessons shared by two or more groups of the stream; with `ownKey` set, only those the own group attends. */
export function commonLessons(rows: StreamRow[], ownKey: string | null): StreamRow[] {
  return rows.filter((r) => r.groupKeys.length >= 2 && r.status === "scheduled" && (ownKey === null || r.groupKeys.includes(ownKey)));
}

export function formatCommonLessons(intake: number, monday: LocalDate, rows: StreamRow[], ownGroup: LogicalGroup | null, view: TeacherView = "bold"): string {
  const ownKey = ownGroup?.key ?? null;
  const shared = commonLessons(rows, ownKey);
  const head = ownGroup
    ? `<b>Общие пары потока 20${intake} с ${esc(ownGroup.title)}</b>\n<i>неделя ${fmtDDMM(monday)} – ${fmtDDMM(addDays(monday, 6))}</i>`
    : `<b>Общие пары потока 20${intake}</b>\n<i>неделя ${fmtDDMM(monday)} – ${fmtDDMM(addDays(monday, 6))}</i>`;
  if (!shared.length) return `${head}\n\nНа этой неделе общих пар нет.`;
  const byDate = new Map<LocalDate, StreamRow[]>();
  for (const r of shared) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const parts = [...byDate.entries()].map(([date, list]) => {
    const lines = list.map((r) => {
      const time = r.start != null ? `<code>${fmtHHMM(r.start)}${r.end != null ? `–${fmtHHMM(r.end)}` : ""}</code> ` : "";
      const where = r.isDistance ? "💻" : r.room ? esc(r.room) : "";
      const others = r.groups.filter((_, i) => r.groupKeys[i] !== ownKey);
      return `   ${time}${esc(r.subject)} <i>${lessonTypeLabel(r.type)}</i>${where ? ` · ${where}` : ""}\n      вместе с: ${others.map(esc).join(", ") || "—"}`;
    });
    return `<b>${weekdayName(date)}</b> <i>${fmtDDMM(date)}</i>\n${lines.join("\n")}`;
  });
  return `${head}\n\n${parts.join("\n\n")}`;
}
