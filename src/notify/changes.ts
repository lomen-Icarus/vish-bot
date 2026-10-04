/**
 * Как показать изменения расписания человеку. Изменения делятся на два вида:
 *
 *  - НА СЕГОДНЯ — срочное: всё расписание дня целиком, а затронутые пары
 *    помечены (✏️ изменилась, ➕ новая, ❌ отменена) с пояснением, в чём дело;
 *  - на будущее — списком по дням, как раньше, с пометкой, какая это неделя.
 *
 * Здесь только данные и текст; картинку рисуют темы постеров по тем же
 * пометкам (DayRenderInput.lessons[].mark, src/render/core.ts).
 */
import type { ChangeEvent } from "../schedule/diff.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { groupByDate, positionKey, type Occurrence } from "../schedule/model.js";
import type { WeekInfo } from "../schedule/service.js";
import { esc, formatChangeEvent, formatDay, MARK_ICON, shortTeacher, type LessonMark, type MarkedLesson, type TeacherView } from "../schedule/format.js";
import { addDays, fmtDDMM, fmtDayMonth, fmtHHMM, mondayOf, weekdayName, type LocalDate, type WallClock } from "../time.js";

const range = (o: Occurrence): string => (o.start != null && o.end != null ? `${fmtHHMM(o.start)}–${fmtHHMM(o.end)}` : "—");
const where = (date: LocalDate, slot: number | null): string => `${fmtDDMM(date)}${slot ? ` (${slot} пара)` : ""}`;

/** Касается ли изменение этого дня: пара была или стала в этот день. */
export function touchesDate(e: ChangeEvent, date: LocalDate): boolean {
  return e.date === date || e.before?.date === date || e.after?.date === date;
}

/** Срочное (касается сегодняшнего дня) — отдельно от остального. */
export function splitByToday(events: ChangeEvent[], today: LocalDate): { today: ChangeEvent[]; later: ChangeEvent[] } {
  const now: ChangeEvent[] = [];
  const later: ChangeEvent[] = [];
  for (const e of events) (touchesDate(e, today) ? now : later).push(e);
  return { today: now, later };
}

/** «ауд. Т-310 → Т-204; время 11:40–13:00 → 12:00–13:20» — простым текстом. */
export function changedNote(e: ChangeEvent): string {
  const b = e.before!;
  const a = e.after!;
  const bits: string[] = [];
  for (const f of e.fields ?? []) {
    if (f === "room") bits.push(`ауд. ${b.room ?? "—"} → ${a.room ?? "—"}`);
    if (f === "teacher") bits.push(`преп. ${shortTeacher(b.teacher ?? "—")} → ${shortTeacher(a.teacher ?? "—")}`);
    if (f === "time") bits.push(`время ${range(b)} → ${range(a)}`);
    if (f === "distance") bits.push(a.isDistance ? "теперь дистанционно" : "теперь очно");
    if (f === "status" && a.status === "moved") bits.push(`перенесена${a.movedTo ? ` на ${where(a.movedTo.date, a.movedTo.slot ?? null)}` : ""}`);
    if (f === "status" && a.status === "scheduled") bits.push("перенос отменён, пара снова на месте");
    if (f === "movedTo" && !(e.fields ?? []).includes("status") && a.movedTo) bits.push(`перенос теперь на ${where(a.movedTo.date, a.movedTo.slot ?? null)}`);
  }
  return bits.join("; ");
}

const RANK: Record<LessonMark["kind"], number> = { changed: 0, added: 1, cancelled: 2 };

/**
 * Пары дня с пометками изменений. Отменённые и перенесённые с этого дня пары
 * в расписании уже не числятся — их возвращаем в список зачёркнутыми, чтобы
 * человек видел, что именно отменили.
 */
export function markDay(lessons: Occurrence[], events: ChangeEvent[], date: LocalDate): MarkedLesson[] {
  const out: MarkedLesson[] = lessons.map((o) => ({ ...o }));
  const byKey = new Map(out.map((o) => [positionKey(o), o]));
  const put = (o: Occurrence, mark: LessonMark): void => {
    const key = positionKey(o);
    let target = byKey.get(key);
    if (!target) {
      target = { ...o };
      out.push(target);
      byKey.set(key, target);
    }
    // Два изменения одной пары за раз — одна пометка: важнее отмена, потом «новая».
    const prev = target.mark;
    if (!prev) target.mark = { ...mark };
    else target.mark = { kind: RANK[mark.kind] > RANK[prev.kind] ? mark.kind : prev.kind, note: [prev.note, mark.note].filter(Boolean).join("; ") };
  };
  for (const e of events) {
    const b = e.before;
    const a = e.after;
    if (e.kind === "changed" && a && b) {
      if (a.date !== date) continue;
      // Пару перенесли с этого дня: для сегодняшнего расписания её больше нет.
      const gone = a.status === "moved" && b.status === "scheduled";
      put(a, { kind: gone ? "cancelled" : "changed", note: changedNote(e) });
    } else if (e.kind === "added" && a) {
      if (a.date !== date) continue;
      put(a, { kind: "added", note: a.movedFrom ? `перенос с ${where(a.movedFrom.date, a.movedFrom.slot ?? null)}` : "" });
    } else if (e.kind === "removed" && b) {
      if (b.date !== date) continue;
      put(b, { kind: "cancelled", note: "" });
    } else if (e.kind === "moved" && a && b) {
      if (a.date === date && b.date === date) put(a, { kind: "changed", note: b.slot !== a.slot ? `была ${b.slot ?? "?"} пара (${range(b)})` : `время ${range(b)} → ${range(a)}` });
      else if (a.date === date) put(a, { kind: "added", note: `перенос с ${where(b.date, b.slot)}` });
      else if (b.date === date) put(b, { kind: "cancelled", note: `перенесена на ${where(a.date, a.slot)}` });
    }
  }
  const order = (o: Occurrence): number => o.start ?? (o.slot != null ? o.slot * 100 : 10_000);
  return out.sort((x, y) => order(x) - order(y));
}

/** Одна строка про помеченную пару — для подписи к картинке. */
export function markLine(o: MarkedLesson): string {
  const m = o.mark!;
  const head = `${MARK_ICON[m.kind]} ${o.slot != null ? `${o.slot} пара ` : ""}<code>${range(o)}</code> <b>${esc(o.subject)}</b>`;
  if (m.kind === "cancelled") return `${head} — <b>отменена</b>${m.note ? `, ${esc(m.note)}` : ""}`;
  if (m.kind === "added") return `${head} — новая пара${m.note ? `, ${esc(m.note)}` : ""}`;
  return `${head} — ${esc(m.note || "изменения")}`;
}

export const TODAY_HEAD = "🚨 <b>ИЗМЕНЕНИЯ НА СЕГОДНЯ</b>";

/** Текст: шапка «на сегодня» и всё расписание дня с пометками. */
export function todayText(group: LogicalGroup, date: LocalDate, marked: MarkedLesson[], info: WeekInfo, now: WallClock, teacherView?: TeacherView): string {
  return `${TODAY_HEAD} · ${esc(group.title)}\n\n${formatDay(group, date, marked, info, now.date, { now, teacherView, hideTitle: true })}`;
}

/** Подпись к картинке дня: шапка и только то, что изменилось (сам день — на картинке). */
export function todayCaption(group: LogicalGroup, marked: MarkedLesson[]): string {
  const lines = marked.filter((o) => o.mark).map(markLine);
  return `${TODAY_HEAD} · ${esc(group.title)}\n\n${lines.join("\n")}`;
}

/** «на этой неделе», «на следующей неделе»… — какая неделя затронута. */
export function weekPhrase(dates: LocalDate[], today: LocalDate): string {
  const base = Date.parse(mondayOf(today));
  const offsets = [...new Set(dates.filter((d) => d > today).map((d) => Math.round((Date.parse(mondayOf(d)) - base) / (7 * 86_400_000))))].sort((x, y) => x - y);
  if (!offsets.length) return "";
  if (offsets.length === 1) return offsets[0] === 0 ? "на этой неделе" : offsets[0] === 1 ? "на следующей неделе" : `на неделе с ${fmtDDMM(addDays(mondayOf(today), offsets[0]! * 7))}`;
  if (offsets.length === 2 && offsets[0] === 0 && offsets[1] === 1) return "на этой и следующей неделе";
  return "на ближайшие недели";
}

/** Дни, которых касаются изменения (кроме сегодня), по порядку. */
export function laterDates(events: ChangeEvent[], today: LocalDate): LocalDate[] {
  const set = new Set<LocalDate>();
  for (const e of events) for (const d of [e.date, e.before?.date, e.after?.date]) if (d && d !== today && d >= today) set.add(d);
  return [...set].sort();
}

export const LATER_HEAD = "🗓 <b>Изменения на будущее</b>";

/** Текст: изменения на другие дни списком по дням, как раньше, с пометкой недели. */
export function laterText(group: LogicalGroup, events: ChangeEvent[], today: LocalDate): string {
  const phrase = weekPhrase(laterDates(events, today), today);
  const tomorrow = addDays(today, 1);
  const blocks = [...groupByDate(events).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => `<b>${weekdayName(date)}, ${fmtDayMonth(date)}</b>${date === tomorrow ? " · <i>завтра</i>" : ""}\n${list.map(formatChangeEvent).join("\n")}`);
  return `${LATER_HEAD} · ${esc(group.title)}${phrase ? `\n<i>${phrase}</i>` : ""}\n\n${blocks.join("\n\n")}`;
}
