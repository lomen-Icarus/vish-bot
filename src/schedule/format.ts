import { fmtDDMM, fmtDayMonth, fmtHHMM, weekdayName, weekdayShort, type LocalDate, type WallClock } from "../time.js";
import type { ChangeEvent } from "./diff.js";
import type { LogicalGroup } from "./groups.js";
import { lessonTypeLabel, type Occurrence } from "./model.js";
import type { WeekInfo } from "./service.js";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLOT_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

export interface FormatOptions {
  /** Hide lessons of other subgroups. */
  subgroup?: number | null;
  /** Current wall clock, to mark the ongoing lesson. */
  now?: WallClock;
  /** Total portal variants of the group; used for "только ВИШ-13-23" hints. */
  variantCount?: number;
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

export function dayHeader(date: LocalDate, info: WeekInfo, today: LocalDate): string {
  const rel = date === today ? "Сегодня" : date === addDaysStr(today, 1) ? "Завтра" : date === addDaysStr(today, -1) ? "Вчера" : null;
  const wl = weekLabel(info);
  const main = `${weekdayName(date)}, ${fmtDayMonth(date)}`;
  return `<b>${rel ? `${rel} · ` : ""}${main}</b>${wl ? `\n<i>${wl}</i>` : ""}`;
}

function addDaysStr(date: LocalDate, n: number): LocalDate {
  const t = Date.parse(date) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function formatLesson(o: Occurrence, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  const ongoing = opts.now && opts.now.date === o.date && o.start != null && o.end != null && opts.now.minutes >= o.start && opts.now.minutes < o.end;
  const moved = o.status === "moved";
  const subject = moved ? `<s>${esc(o.subject)}</s>` : `<b>${esc(o.subject)}</b>`;
  lines.push(`${slotBadge(o)} ${timeRange(o) ? `<code>${timeRange(o)}</code> ` : ""}${subject}${ongoing ? " ▶️" : ""}`);
  const meta: string[] = [];
  meta.push(lessonTypeLabel(o.type));
  if (o.isDistance) meta.push("💻 дистанционно");
  else if (o.room) meta.push(`ауд. ${esc(o.room)}`);
  if (o.teacher) meta.push(esc(o.teacher));
  if (o.subgroup) meta.push(`${o.subgroup} подгр.`);
  if (opts.variantCount && opts.variantCount > 1 && o.sources.length < opts.variantCount) meta.push(`только ${o.sources.map(esc).join(", ")}`);
  lines.push(`     ${meta.join(" · ")}`);
  if (moved && o.movedTo) lines.push(`     ↪️ перенесена на ${fmtDDMM(o.movedTo.date)}${o.movedTo.slot ? ` (${o.movedTo.slot} пара)` : ""}`);
  if (o.movedFrom) lines.push(`     ↩️ перенос с ${fmtDDMM(o.movedFrom.date)} (${o.movedFrom.slot} пара)`);
  if (o.substituted) {
    const bits: string[] = [];
    if (o.substituted.room !== undefined && o.substituted.room !== o.room) bits.push(`ауд. ${esc(o.substituted.room ?? "—")} → ${esc(o.room ?? "—")}`);
    if (o.substituted.teacher !== undefined && o.substituted.teacher !== o.teacher) bits.push(`преп. ${esc(o.substituted.teacher ?? "—")} → ${esc(o.teacher ?? "—")}`);
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
  const body = list.map((o) => formatLesson(o, { ...opts, variantCount: group.portalIds.length })).join("\n\n");
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
  const wl = weekLabel(info);
  const parts: string[] = [`<b>Неделя ${fmtDDMM(monday)} – ${fmtDDMM(addDaysStr(monday, 6))}</b>${wl ? ` · <i>${wl}</i>` : ""}\n${esc(group.title)}`];
  for (let i = 0; i < 7; i++) {
    const date = addDaysStr(monday, i);
    const list = filterSubgroup(byDate.get(date) ?? [], opts.subgroup);
    if (list.length === 0 && i === 6) continue;
    const title = `<b>${weekdayName(date)}</b> <i>${fmtDDMM(date)}${date === today ? " · сегодня" : ""}</i>`;
    if (list.length === 0) {
      parts.push(`${title}\n   — пар нет`);
      continue;
    }
    const rows = list.map((o) => {
      const moved = o.status === "moved";
      const subj = moved ? `<s>${esc(o.subject)}</s>` : esc(o.subject);
      const where = o.isDistance ? "💻" : o.room ? esc(o.room) : "";
      const sg = o.subgroup ? ` (${o.subgroup} п.)` : "";
      const flags = `${o.movedFrom ? " ↩️" : ""}${o.substituted ? " 🔁" : ""}`;
      return `   ${slotBadge(o)} ${timeRange(o) ? `<code>${fmtHHMM(o.start!)}</code> ` : ""}${subj} <i>${lessonTypeLabel(o.type)}</i>${where ? ` · ${where}` : ""}${sg}${flags}`;
    });
    parts.push(`${title}\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

function describe(o: Occurrence): string {
  const where = o.isDistance ? "дистанционно" : o.room ? `ауд. ${esc(o.room)}` : "";
  const sg = o.subgroup ? `, ${o.subgroup} подгр.` : "";
  return `<b>${esc(o.subject)}</b> (${lessonTypeLabel(o.type)}${sg})${where ? ` · ${where}` : ""}`;
}

function when(o: Occurrence): string {
  const slot = o.slot != null ? `${o.slot} пара` : "";
  const time = timeRange(o);
  return `${fmtDDMM(o.date)} (${weekdayShort(o.date)})${slot ? `, ${slot}` : ""}${time ? ` ${time}` : ""}`;
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
