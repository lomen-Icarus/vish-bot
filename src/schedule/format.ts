import { addDays, fmtDDMM, fmtDayMonth, fmtHHMM, weekdayName, weekdayShort, type LocalDate, type WallClock } from "../time.js";
import type { ChangeEvent } from "./diff.js";
import type { LogicalGroup } from "./groups.js";
import { lessonTypeLabel, type Occurrence } from "./model.js";
import type { WeekInfo } from "./service.js";
import { samePerson, shortName } from "../text/match.js";

/** Русское склонение по числу: 1 слайд, 2 слайда, 5 слайдов, 21 слайд. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLOT_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

export interface FormatOptions {
  /** Hide lessons of other subgroups. */
  subgroup?: number | null;
  /** Current wall clock, to mark the ongoing lesson. */
  now?: WallClock;
  /** Как показывать преподавателя: с выделением, обычным текстом или никак. */
  teacherView?: TeacherView;
}

export function filterSubgroup(list: Occurrence[], subgroup: number | null | undefined): Occurrence[] {
  if (!subgroup) return list;
  return list.filter((o) => o.subgroup == null || o.subgroup === subgroup);
}

function timeRange(o: Occurrence): string {
  if (o.start == null || o.end == null) return "";
  return `${fmtHHMM(o.start)}–${fmtHHMM(o.end)}`;
}

function slotBadge(o: Occurrence): string {
  return o.slot != null ? (SLOT_EMOJI[o.slot] ?? `${o.slot}.`) : "•";
}

export function weekLabel(info: WeekInfo): string {
  if (info.week == null) return "";
  const parity = info.parity === "odd" ? "нечётная" : info.parity === "even" ? "чётная" : "";
  return `${info.week}-я неделя${parity ? `, ${parity}` : ""}`;
}

/** Loud parity marker for Telegram text: "🔶 НЕЧЁТНАЯ · 3-я неделя". */
export function parityLine(info: WeekInfo): string {
  if (info.week == null) return "";
  if (info.parity === "odd") return `🔶 <b>НЕЧЁТНАЯ</b> · ${info.week}-я неделя`;
  if (info.parity === "even") return `🔷 <b>ЧЁТНАЯ</b> · ${info.week}-я неделя`;
  return `${info.week}-я неделя`;
}

export function dayHeader(date: LocalDate, info: WeekInfo, today: LocalDate): string {
  const rel = date === today ? "Сегодня" : date === addDays(today, 1) ? "Завтра" : date === addDays(today, -1) ? "Вчера" : null;
  const pl = parityLine(info);
  const main = `${weekdayName(date)}, ${fmtDayMonth(date)}`;
  return `<b>${rel ? `${rel} · ` : ""}${main}</b>${pl ? `\n${pl}` : ""}`;
}

/**
 * Telegram rejects a message whose HTML is cut mid-tag, so a long text is
 * trimmed at a line break and every tag left open is closed again.
 */
export function clampHtml(html: string, limit = 3900): string {
  if (html.length <= limit) return html;
  let cut = html.slice(0, limit);
  const nl = cut.lastIndexOf("\n");
  if (nl > limit / 2) cut = cut.slice(0, nl);
  if (cut.lastIndexOf("<") > cut.lastIndexOf(">")) cut = cut.slice(0, cut.lastIndexOf("<"));
  const open: string[] = [];
  for (const m of cut.matchAll(/<(\/?)(b|strong|i|em|u|s|code|pre|a)\b[^>]*>/g)) {
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      const i = open.lastIndexOf(tag);
      if (i >= 0) open.splice(i, 1);
    } else {
      open.push(tag);
    }
  }
  return `${cut}${open.reverse().map((t) => `</${t}>`).join("")}\n…`;
}

/**
 * Подпись у фото в Telegram — 1024 символа, и считаются они по видимому тексту,
 * а не по разметке. Тегов не считаем, запас в 24 символа оставляем на всякий.
 */
export const CAPTION_MAX = 1000;

/** Влезет ли расписание в подпись к постеру одним сообщением. */
export function captionFits(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").length <= CAPTION_MAX;
}

/**
 * Как показывать преподавателя: жирным, обычным текстом или не показывать.
 * Выбирается в настройках; по умолчанию с выделением — фамилию ищут глазами.
 */
export type TeacherView = "bold" | "plain" | "off";

/**
 * «доц. к.пед.н. Ярдухина Светлана Александровна» → «Ярдухина С. А.».
 * Должность и степень портал иногда вклеивает прямо в имя; в расписании они
 * только занимают строку, а полностью человек подписан в своей карточке.
 * Сам разбор ФИО живёт в src/text/match.ts — он общий для всего бота.
 */
export const shortTeacher = shortName;

/** Один и тот же преподаватель, как бы его ни записали в двух местах портала. */
export const sameTeacher = samePerson;

/**
 * «Иванова И. И.» с неразрывными пробелами: фамилия и инициалы — одно целое.
 * Не влезла строка — переносится вся подпись, а не «Иванова» здесь и «И. И.»
 * на следующей строке.
 */
export function unbreakable(s: string): string {
  return s.replace(/ /g, "\u00a0");
}

/** Подпись преподавателя на постере: коротко, либо ничего, если выключено. */
export function posterTeacher(name: string | null | undefined, view: TeacherView | undefined): string | null {
  if (!name || view === "off") return null;
  return unbreakable(shortTeacher(name));
}

/** Подпись преподавателя в строке расписания с учётом настройки. */
export function teacherLabel(name: string | null | undefined, view: TeacherView = "bold"): string {
  if (!name || view === "off") return "";
  const short = esc(unbreakable(shortTeacher(name)));
  return view === "bold" ? `<b>${short}</b>` : short;
}

export function formatLesson(o: Occurrence, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  const ongoing = opts.now && opts.now.date === o.date && o.start != null && o.end != null && opts.now.minutes >= o.start && opts.now.minutes < o.end;
  const moved = o.status === "moved";
  const subject = moved ? `<s>${esc(o.subject)}</s>` : `<b>${esc(o.subject)}</b>`;
  lines.push(`${slotBadge(o)} ${timeRange(o) ? `<code>${timeRange(o)}</code> ` : ""}${subject}${ongoing ? " ▶️" : ""}`);
  const meta: string[] = [];
  meta.push(esc(lessonTypeLabel(o.type)));
  if (o.isDistance) meta.push("💻 дистанционно");
  else if (o.room) meta.push(`ауд. ${esc(o.room)}`);
  const teacher = teacherLabel(o.teacher, opts.teacherView);
  if (teacher) meta.push(teacher);
  if (o.subgroup) meta.push(`${o.subgroup} подгр.`);
  if (o.groups?.length) meta.push(o.groups.map(esc).join(", "));
  lines.push(`     ${meta.join(" · ")}`);
  if (o.topic && o.isDistance) lines.push(`     📝 ${esc(o.topic.length > 90 ? o.topic.slice(0, 87).trimEnd() + "…" : o.topic)}`);
  if (moved && o.movedTo) lines.push(`     ↪️ перенесена на ${fmtDDMM(o.movedTo.date)}${o.movedTo.slot ? ` (${o.movedTo.slot} пара)` : ""}`);
  if (o.movedFrom) lines.push(`     ↩️ перенос с ${fmtDDMM(o.movedFrom.date)} (${o.movedFrom.slot} пара)`);
  if (o.substituted) {
    const bits: string[] = [];
    if (o.substituted.room !== undefined && o.substituted.room !== o.room) bits.push(`ауд. ${esc(o.substituted.room ?? "—")} → ${esc(o.room ?? "—")}`);
    if (o.substituted.teacher !== undefined && !sameTeacher(o.substituted.teacher, o.teacher)) bits.push(`преп. ${esc(shortTeacher(o.substituted.teacher ?? "—"))} → ${esc(shortTeacher(o.teacher ?? "—"))}`);
    if (o.substituted.distance === false && o.isDistance) bits.push("переведена в дистант");
    if (bits.length) lines.push(`     🔁 замена: ${bits.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatDay(group: LogicalGroup, date: LocalDate, lessons: Occurrence[], info: WeekInfo, today: LocalDate, opts: FormatOptions = {}): string {
  const list = filterSubgroup(lessons, opts.subgroup);
  const head = `${dayHeader(date, info, today)}\n${esc(group.title)}`;
  if (list.length === 0) return `${head}\n\n😴 Пар нет`;
  const active = list.filter((o) => o.status === "scheduled");
  const body = list.map((o) => formatLesson(o, opts)).join("\n\n");
  const summary = active.length ? `\n\n${countLessons(active.length)}${firstLast(active)}` : "";
  return `${head}\n\n${body}${summary}`;
}

function firstLast(list: Occurrence[]): string {
  const withTime = list.filter((o) => o.start != null && o.end != null);
  if (!withTime.length) return "";
  const first = Math.min(...withTime.map((o) => o.start!));
  const last = Math.max(...withTime.map((o) => o.end!));
  return ` · ${fmtHHMM(first)}–${fmtHHMM(last)}`;
}

export function countLessons(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "пара" : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? "пары" : "пар";
  return `${n} ${word}`;
}

export function formatWeek(group: LogicalGroup, monday: LocalDate, byDate: Map<LocalDate, Occurrence[]>, info: WeekInfo, today: LocalDate, opts: FormatOptions = {}): string {
  const pl = parityLine(info);
  const parts: string[] = [`<b>Неделя ${fmtDDMM(monday)} – ${fmtDDMM(addDays(monday, 6))}</b>${pl ? `\n${pl}` : ""}\n${esc(group.title)}`];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const list = filterSubgroup(byDate.get(date) ?? [], opts.subgroup);
    if (list.length === 0 && i === 6) continue;
    const title = `<b>${weekdayName(date)}</b> · <i>${fmtDDMM(date)}${date === today ? " · сегодня" : ""}</i>`;
    if (list.length === 0) {
      parts.push(`${title}\n   — пар нет`);
      continue;
    }
    // Две строки на пару: сверху время и предмет, снизу — что это за пара,
    // где и кто ведёт. Так глаз находит нужное, не разбирая одну длинную строку.
    const rows = list.map((o) => {
      const moved = o.status === "moved";
      const subj = moved ? `<s>${esc(o.subject)}</s>` : `<b>${esc(o.subject)}</b>`;
      const where = o.isDistance ? "💻 дистанционно" : o.room ? `ауд. ${esc(o.room)}` : "";
      const meta = [esc(lessonTypeLabel(o.type)), where, teacherLabel(o.teacher, opts.teacherView), o.subgroup ? `${o.subgroup} подгр.` : "", o.movedFrom ? "↩️ перенос" : "", o.substituted ? "🔁 замена" : ""].filter(Boolean);
      // Показываем и конец пары: «когда освобожусь» спрашивают не реже, чем «когда начало».
      return `   ${slotBadge(o)} ${timeRange(o) ? `<code>${timeRange(o)}</code> ` : ""}${subj}\n        <i>${meta.join(" · ")}</i>`;
    });
    parts.push(`${title}\n${rows.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

function describe(o: Occurrence): string {
  const where = o.isDistance ? "дистанционно" : o.room ? `ауд. ${esc(o.room)}` : "";
  const sg = o.subgroup ? `, ${o.subgroup} подгр.` : "";
  return `<b>${esc(o.subject)}</b> (${esc(lessonTypeLabel(o.type))}${sg})${where ? ` · ${where}` : ""}`;
}

function when(o: Occurrence): string {
  const slot = o.slot != null ? `${o.slot} пара` : "";
  const time = timeRange(o);
  return `${fmtDDMM(o.date)} (${weekdayShort(o.date)})${slot ? `, ${slot}` : ""}${time ? ` ${time}` : ""}`;
}

/** Teacher card built from the portal's webinar page (works without an account). */
export function formatWebinarTeacher(t: { name: string; position: string | null; degree: string | null; subjects: string[]; groups: string[] }, upcoming: Array<{ date: LocalDate; slot: number | null; start: number | null; end: number | null; subject: string; type: string; groups: string[]; title: string | null }>, hasFullSchedule: boolean): string {
  const title = [t.position, t.degree].filter(Boolean).join(", ");
  const lines = [`👨‍🏫 <b>${esc(t.name)}</b>${title ? ` <i>${esc(title)}</i>` : ""}`, ""];
  lines.push(`<b>Ведёт онлайн:</b> ${t.subjects.map(esc).join(", ")}`);
  if (t.groups.length) lines.push(`<b>Группы:</b> ${t.groups.map(esc).join(", ")}`);
  if (upcoming.length) {
    lines.push("", "<b>Ближайшие онлайн-пары</b>");
    for (const l of upcoming) {
      const when = `${weekdayShort(l.date)} ${fmtDDMM(l.date)}`;
      const time = l.start != null ? ` · <code>${fmtHHMM(l.start)}${l.end != null ? `–${fmtHHMM(l.end)}` : ""}</code>` : "";
      lines.push(`${when}${time}${l.slot ? ` · ${l.slot} пара` : ""} — <b>${esc(l.subject)}</b> (${esc(lessonTypeLabel(l.type))})`);
      if (l.groups.length) lines.push(`     ${esc(l.groups.join(", "))}`);
      if (l.title) lines.push(`     📝 ${esc(l.title.length > 90 ? l.title.slice(0, 87).trimEnd() + "…" : l.title)}`);
    }
  } else {
    lines.push("", "<i>Ближайших онлайн-пар нет.</i>");
  }
  if (!hasFullSchedule) lines.push("", "<i>Это данные со страницы вебинаров портала: видны только онлайн-пары ближайших дней. Очные пары преподавателя портал показывает лишь авторизованным.</i>");
  return lines.join("\n");
}

export function formatChangeEvent(e: ChangeEvent): string {
  switch (e.kind) {
    case "added":
      return `➕ ${when(e.after!)}: ${describe(e.after!)}${e.after!.movedFrom ? ` — перенос с ${fmtDDMM(e.after!.movedFrom.date)} (${e.after!.movedFrom.slot} пара)` : ""}`;
    case "removed":
      return `➖ ${when(e.before!)}: ${describe(e.before!)} — убрана из расписания`;
    case "moved":
      return `🔁 ${describe(e.after!)}: ${when(e.before!)} → ${when(e.after!)}`;
    case "changed": {
      const b = e.before!;
      const a = e.after!;
      const bits: string[] = [];
      for (const f of e.fields ?? []) {
        if (f === "room") bits.push(`ауд. ${esc(b.room ?? "—")} → ${esc(a.room ?? "—")}`);
        if (f === "teacher") bits.push(`преп. ${esc(b.teacher ?? "—")} → ${esc(a.teacher ?? "—")}`);
        if (f === "time") bits.push(`время ${timeRange(b) || "—"} → ${timeRange(a) || "—"}`);
        if (f === "distance") bits.push(a.isDistance ? "теперь дистанционно 💻" : "теперь очно");
        if (f === "status" && a.status === "moved") bits.push(`перенесена${a.movedTo ? ` на ${fmtDDMM(a.movedTo.date)}${a.movedTo.slot ? ` (${a.movedTo.slot} пара)` : ""}` : ""}`);
        if (f === "status" && a.status === "scheduled") bits.push("перенос отменён, пара снова на месте");
      }
      return `✏️ ${when(a)}: ${describe(a)} — ${bits.join("; ") || "изменения"}`;
    }
  }
}

export function formatChanges(group: LogicalGroup, events: ChangeEvent[]): string {
  const byDate = new Map<LocalDate, ChangeEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }
  const blocks = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => `<b>${weekdayName(date)}, ${fmtDayMonth(date)}</b>\n${list.map(formatChangeEvent).join("\n")}`);
  return `🔔 <b>Изменения в расписании ${esc(group.title)}</b>\n\n${blocks.join("\n\n")}`;
}

export function formatNotice(text: string): string {
  return text.trim() ? `📢 <b>Объявление на портале расписания</b>\n\n${esc(text.trim())}` : `📢 Объявление на портале расписания снято.`;
}
