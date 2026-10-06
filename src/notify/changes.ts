/**
 * Как показать изменения расписания человеку. Изменения делятся на два вида:
 *
 *  - НА СЕГОДНЯ — срочное: всё расписание дня целиком, а затронутые пары
 *    помечены (✏️ изменилась, ➕ новая, ↪️ перенесена, ❌ отменена) с
 *    пояснением, в чём дело;
 *  - на будущее — списком по дням, как раньше, с пометкой, какая это неделя.
 *
 * Приходит это всегда одним сообщением: сегодня сверху, будущее следом, а
 * картинки дней — одним альбомом с подписью. Здесь только данные и текст;
 * картинку рисуют темы постеров по тем же пометкам
 * (DayRenderInput.lessons[].mark, src/render/core.ts).
 */
import type { ChangeEvent } from "../schedule/diff.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { groupByDate, positionKey, type Occurrence } from "../schedule/model.js";
import type { WeekInfo } from "../schedule/service.js";
import { captionFits, clampHtml, CAPTION_MAX, esc, formatChangeEvent, formatDay, MARK_ICON, plural, shortTeacher, type LessonMark, type MarkedLesson, type TeacherView } from "../schedule/format.js";
import { addDays, fmtDDMM, fmtDayMonth, fmtHHMM, mondayOf, weekdayName, weekdayShort, type LocalDate, type WallClock } from "../time.js";

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

const RANK: Record<LessonMark["kind"], number> = { changed: 0, added: 1, moved: 2, cancelled: 3 };

/**
 * Пары дня с пометками изменений. Отменённые и перенесённые с этого дня пары
 * в расписании уже не числятся — их возвращаем в список зачёркнутыми, чтобы
 * человек видел, что именно отменили или куда перенесли.
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
    // Два изменения одной пары за раз — одна пометка: важнее отмена, потом перенос, потом «новая».
    const prev = target.mark;
    if (!prev) target.mark = { ...mark };
    else target.mark = { kind: RANK[mark.kind] > RANK[prev.kind] ? mark.kind : prev.kind, note: [prev.note, mark.note].filter(Boolean).join("; ") };
  };
  for (const e of events) {
    const b = e.before;
    const a = e.after;
    if (e.kind === "changed" && a && b) {
      if (a.date !== date) continue;
      // Пару перенесли с этого дня: здесь её больше нет, но она не отменена.
      const gone = a.status === "moved" && b.status === "scheduled";
      put(a, gone ? { kind: "moved", note: a.movedTo ? `на ${where(a.movedTo.date, a.movedTo.slot ?? null)}` : "" } : { kind: "changed", note: changedNote(e) });
    } else if (e.kind === "added" && a) {
      if (a.date !== date) continue;
      put(a, { kind: "added", note: a.movedFrom ? `перенос с ${where(a.movedFrom.date, a.movedFrom.slot ?? null)}` : "" });
    } else if (e.kind === "removed" && b) {
      if (b.date !== date) continue;
      put(b, { kind: "cancelled", note: "" });
    } else if (e.kind === "moved" && a && b) {
      if (a.date === date && b.date === date) put(a, { kind: "changed", note: b.slot !== a.slot ? `была ${b.slot ?? "?"} пара (${range(b)})` : `время ${range(b)} → ${range(a)}` });
      else if (a.date === date) put(a, { kind: "added", note: `перенос с ${where(b.date, b.slot)}` });
      else if (b.date === date) put(b, { kind: "moved", note: `на ${where(a.date, a.slot)}` });
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
  if (m.kind === "moved") return `${head} — <b>перенесена</b>${m.note ? ` ${esc(m.note)}` : ""}`;
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

/**
 * Текст: изменения на другие дни списком по дням, как раньше, с пометкой недели.
 * `title: false` — без названия группы (оно уже есть выше, в «на сегодня»);
 * `limit` — показать только первые столько изменений, про остальные — строкой
 * «…и ещё N» (подпись к картинке у Telegram короткая).
 */
export function laterText(group: LogicalGroup, events: ChangeEvent[], today: LocalDate, opts: { title?: boolean; limit?: number } = {}): string {
  const phrase = weekPhrase(laterDates(events, today), today);
  const tomorrow = addDays(today, 1);
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const shown = opts.limit != null ? sorted.slice(0, Math.max(0, opts.limit)) : sorted;
  const blocks = [...groupByDate(shown).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => `<b>${weekdayName(date)}, ${fmtDayMonth(date)}</b>${date === tomorrow ? " · <i>завтра</i>" : ""}\n${list.map(formatChangeEvent).join("\n")}`);
  const rest = sorted.length - shown.length;
  if (rest > 0) blocks.push(`<i>…и ещё ${rest} ${plural(rest, "изменение", "изменения", "изменений")} — все в «🔔 Изменения»</i>`);
  return `${LATER_HEAD}${opts.title === false ? "" : ` · ${esc(group.title)}`}${phrase ? `\n<i>${phrase}</i>` : ""}\n\n${blocks.join("\n\n")}`;
}

/** Полоса на картинке дня: «ИЗМЕНЕНИЯ НА ЗАВТРА · 07.10», «ИЗМЕНЕНИЯ НА ПТ 09.10». */
export function laterBanner(date: LocalDate, today: LocalDate): string {
  return date === addDays(today, 1) ? `ИЗМЕНЕНИЯ НА ЗАВТРА · ${fmtDDMM(date)}` : `ИЗМЕНЕНИЯ НА ${weekdayShort(date).toUpperCase()} ${fmtDDMM(date)}`;
}

/** Больше картинок будущих дней в одном уведомлении не рисуем (плюс сегодня). */
export const MAX_LATER_POSTERS = 4;

/** День для картинки: пары с пометками и полоса сверху. */
export interface ChangeDay {
  date: LocalDate;
  lessons: MarkedLesson[];
  banner: { text: string; tone: "urgent" | "info" };
}

/**
 * Какие дни показать картинками: сегодня (красная полоса), если его задело, и
 * ближайшие другие (синяя). Перенос «сегодня → пятница» задевает оба дня: в
 * сегодняшнем он зачёркнут «перенесена», в пятнице — «＋ новая пара».
 */
export function changeDays(events: ChangeEvent[], today: LocalDate, lessonsOn: (date: LocalDate) => Occurrence[], maxLater = MAX_LATER_POSTERS): ChangeDay[] {
  const days: ChangeDay[] = [];
  const now = events.filter((e) => touchesDate(e, today));
  if (now.length) days.push({ date: today, lessons: markDay(lessonsOn(today), now, today), banner: { text: "ИЗМЕНЕНИЯ НА СЕГОДНЯ", tone: "urgent" } });
  for (const d of laterDates(events, today).slice(0, Math.max(0, maxLater))) {
    days.push({ date: d, lessons: markDay(lessonsOn(d), events.filter((e) => touchesDate(e, d)), d), banner: { text: laterBanner(d, today), tone: "info" } });
  }
  return days;
}

/**
 * Весь текст уведомления одним сообщением: «на сегодня» со всем днём и
 * пометками, а следом — на будущее (без повтора названия группы). `limit` —
 * сколько изменений на будущее показать (см. laterText).
 */
export function changesMessage(group: LogicalGroup, todayMarked: MarkedLesson[] | null, later: ChangeEvent[], info: WeekInfo, now: WallClock, teacherView?: TeacherView, limit?: number): string {
  const parts: string[] = [];
  if (todayMarked) parts.push(todayText(group, now.date, todayMarked, info, now, teacherView));
  if (later.length) parts.push(laterText(group, later, now.date, { title: !todayMarked, limit }));
  return parts.join("\n\n");
}

/** Лимит текста сообщения с запасом (у Telegram 4096). */
export const MESSAGE_MAX = 3900;

/**
 * Наибольшее n из 0..max, при котором fits(n); длина текста растёт с n,
 * поэтому делим пополам, а не перебираем — изменений после «Разослать» бывают сотни.
 */
function largestFit(max: number, fits: (n: number) => boolean): number | null {
  let lo = 0;
  let hi = max;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Текст уведомления, который точно влезет в одно сообщение: не влезает —
 * будущее показываем не целиком, а «…и ещё N — все в «🔔 Изменения»».
 */
export function changesMessageFit(group: LogicalGroup, todayMarked: MarkedLesson[] | null, later: ChangeEvent[], info: WeekInfo, now: WallClock, teacherView: TeacherView | undefined, head: string): string {
  const build = (n?: number): string => `${head}${changesMessage(group, todayMarked, later, info, now, teacherView, n)}`;
  const whole = build();
  if (whole.length <= MESSAGE_MAX || !later.length) return clampHtml(whole, MESSAGE_MAX);
  const n = largestFit(later.length - 1, (k) => build(k).length <= MESSAGE_MAX);
  return clampHtml(build(n ?? 0), MESSAGE_MAX);
}

/**
 * Подпись к картинке (или альбому) — так, чтобы всё было в одном сообщении.
 * Полный текст («и так, и так»), если влезает; иначе сегодня — только
 * изменившиеся пары, а будущее — столько изменений, сколько поместится.
 * `tail` — ссылки под подписью (у альбома кнопок не бывает).
 */
export function changesCaption(group: LogicalGroup, opts: { todayMarked: MarkedLesson[] | null; later: ChangeEvent[]; today: LocalDate; full: string | null; head: string; tail: string }): string {
  const { todayMarked, later, today, head, tail } = opts;
  if (opts.full && captionFits(`${head}${opts.full}${tail}`)) return `${head}${opts.full}${tail}`;
  const top = todayMarked ? todayCaption(group, todayMarked) : "";
  const build = (n?: number): string => {
    const bottom = later.length ? laterText(group, later, today, { title: !todayMarked, limit: n }) : "";
    return `${head}${[top, bottom].filter(Boolean).join("\n\n")}${tail}`;
  };
  const whole = build();
  if (captionFits(whole)) return whole;
  const n = later.length ? largestFit(later.length - 1, (k) => captionFits(build(k))) : null;
  if (n != null) return build(n);
  // Даже без будущего не влезло (очень много пар сегодня) — режем по строкам.
  return `${clampHtml(`${head}${top}`, CAPTION_MAX - tail.length - 10)}${tail}`;
}
