/**
 * Панель предметов: сколько и когда будет пар по каждому предмету за семестр.
 * Здесь только данные и текст; команда и кнопки — src/bot/handlers/subjects.ts.
 */
import { createHash } from "node:crypto";
import { esc, unbreakable } from "./format.js";
import { lessonTypeLabel, type Occurrence } from "./model.js";
import { shortName } from "../text/match.js";
import { fmtDDMM, fmtHHMM, weekdayShort, type LocalDate } from "../time.js";

export interface SubjectSummary {
  subject: string;
  /** Короткий ключ для callback_data: название предмета бывает длинным. */
  key: string;
  /** Пары предмета по датам (без опустевших слотов перенесённых пар). */
  lessons: Occurrence[];
}

export function subjectKey(subject: string): string {
  return createHash("sha1").update(subject.trim().toLowerCase()).digest("base64url").slice(0, 10);
}

/** Предметы по алфавиту; у каждого — его пары по порядку. */
export function summarizeSubjects(lessons: Occurrence[]): SubjectSummary[] {
  const by = new Map<string, Occurrence[]>();
  for (const o of lessons) {
    // «moved» — это опустевший слот перенесённой пары: пары там нет, она на новом месте.
    if (o.status === "moved") continue;
    by.set(o.subject, [...(by.get(o.subject) ?? []), o]);
  }
  return [...by.entries()]
    .map(([subject, list]) => ({ subject, key: subjectKey(subject), lessons: list.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0)) }))
    .sort((a, b) => a.subject.localeCompare(b.subject, "ru"));
}

/** Сколько пар каждого типа: «ЛК 16 · ПР 16». */
export function typeCounts(lessons: Occurrence[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const o of lessons) counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
  const order = ["лк", "пр", "лб"];
  return [...counts.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99) || a[0].localeCompare(b[0], "ru"));
}

/** Прошла ли пара к моменту «сейчас». */
function isPast(o: Occurrence, today: LocalDate, nowMinutes: number): boolean {
  if (o.date !== today) return o.date < today;
  return o.end != null ? o.end <= nowMinutes : (o.start ?? 0) < nowMinutes;
}

export interface SubjectTableOptions {
  /** Чьё расписание: «ВИШ-12-23» или ФИО преподавателя. */
  owner: string;
  /** «осенний семестр». */
  periodLabel: string;
  today: LocalDate;
  nowMinutes: number;
  /** Показать только один тип пар (лк/пр/лб); null — все. */
  type?: string | null;
}

/**
 * Карточка предмета: итоги и таблица всех пар моноширинным шрифтом, чтобы
 * даты и время стояли столбиками. ✓ — прошла, → — ближайшая.
 */
export function formatSubjectTable(s: SubjectSummary, opts: SubjectTableOptions): string {
  const all = s.lessons;
  const list = opts.type ? all.filter((o) => o.type === opts.type) : all;
  const past = list.filter((o) => isPast(o, opts.today, opts.nowMinutes));
  const next = list.find((o) => !isPast(o, opts.today, opts.nowMinutes));
  const counts = typeCounts(all)
    .map(([t, n]) => `${lessonTypeLabel(t)} ${n}`)
    .join(" · ");
  const teachers = [...new Set(all.map((o) => o.teacher).filter((t): t is string => !!t).map((t) => shortName(t)))];
  const groups = [...new Set(all.flatMap((o) => o.groups ?? []))];
  const lines = [
    `📚 <b>${esc(s.subject)}</b>`,
    `<i>${esc(opts.owner)} · ${esc(opts.periodLabel)}</i>`,
    "",
    `Всего ${all.length}: ${counts}`,
    `${opts.type ? `${lessonTypeLabel(opts.type)}: ` : ""}прошло ${past.length}, осталось ${list.length - past.length}`,
  ];
  if (teachers.length) lines.push(`Преподаватель: ${teachers.map((t) => esc(unbreakable(t))).join(", ")}`);
  if (groups.length) lines.push(`Группы: ${esc(groups.slice(0, 8).join(", "))}${groups.length > 8 ? "…" : ""}`);
  if (next) lines.push(`Ближайшая: ${weekdayShort(next.date)} ${fmtDDMM(next.date)}${next.start != null ? ` · ${fmtHHMM(next.start)}` : ""} · ${lessonTypeLabel(next.type)}${next.isDistance ? " · дистант" : next.room ? ` · ${esc(next.room)}` : ""}`);
  if (!list.length) {
    lines.push("", `<i>Пар типа ${esc(lessonTypeLabel(opts.type ?? ""))} в этом семестре нет.</i>`);
    return lines.join("\n");
  }
  const rows = list.map((o) => {
    const mark = o === next ? "→" : isPast(o, opts.today, opts.nowMinutes) ? "✓" : " ";
    const time = o.start != null ? fmtHHMM(o.start) : "  —  ";
    const type = `${lessonTypeLabel(o.type)}${o.subgroup ? o.subgroup : ""}`.padEnd(4).slice(0, 5);
    const where = o.isDistance ? "дист." : (o.room ?? "—");
    const moved = o.movedFrom ? " ↩" : "";
    return `${mark} ${fmtDDMM(o.date)} ${weekdayShort(o.date)} ${time} ${type} ${where}${moved}`;
  });
  lines.push("", `<pre>${esc(["  Дата  дн Время Тип  Ауд.", ...rows].join("\n"))}</pre>`);
  if (list.some((o) => o.subgroup)) lines.push("<i>Цифра после типа — подгруппа.</i>");
  if (list.some((o) => o.movedFrom)) lines.push("<i>↩ — пара перенесена сюда с другого дня.</i>");
  return lines.join("\n");
}
