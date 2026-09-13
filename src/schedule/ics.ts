/**
 * iCalendar export. Phones open an .ics straight from Telegram and offer to
 * add every lesson to the calendar, alarms included, no HTTPS server needed.
 */
import { lessonTypeLabel, positionKey, type Occurrence } from "./model.js";
import { localToMs, type LocalDate } from "../time.js";

export interface IcsOptions {
  /** Calendar display name, e.g. "ВИШ-12-23". */
  name: string;
  lessons: Occurrence[];
  /** Minutes before the lesson for a VALARM; null = no alarms. */
  alarmMinutes: number | null;
  /** Generation time, for DTSTAMP. */
  now?: Date;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Epoch ms -> "20260914T084000Z". */
function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    // Do not split a multi-byte UTF-8 sequence.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push((start === 0 ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return out.join("\r\n");
}

export function buildIcs(opts: IcsOptions): string {
  const now = opts.now ?? new Date();
  const stamp = utcStamp(now.getTime());
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//vish-bot//Расписание ВИШ ЧувГУ//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeText(opts.name)}`, "X-WR-TIMEZONE:Europe/Moscow"];
  for (const o of opts.lessons) {
    if (o.status !== "scheduled" || o.start == null || o.end == null) continue;
    const startMs = localToMs(o.date, o.start);
    const endMs = localToMs(o.date, o.end);
    const summary = `${o.subject} (${lessonTypeLabel(o.type)})`;
    const desc: string[] = [opts.name];
    if (o.slot != null) desc.push(`${o.slot} пара`);
    if (o.teacher) desc.push(o.teacher);
    if (o.subgroup) desc.push(`${o.subgroup} подгруппа`);
    if (o.movedFrom) desc.push(`перенос с ${o.movedFrom.date}`);
    if (o.isDistance) desc.push("дистанционно");
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${Buffer.from(positionKey(o)).toString("base64url")}@vish-bot`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${utcStamp(startMs)}`);
    lines.push(`DTEND:${utcStamp(endMs)}`);
    lines.push(`SUMMARY:${escapeText(summary)}`);
    if (o.room && !o.isDistance) lines.push(`LOCATION:${escapeText(`ауд. ${o.room}, ЧувГУ`)}`);
    lines.push(`DESCRIPTION:${escapeText(desc.join(" · "))}`);
    lines.push(`CATEGORIES:${escapeText(lessonTypeLabel(o.type))}`);
    if (opts.alarmMinutes != null && opts.alarmMinutes > 0) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${opts.alarmMinutes}M`, `DESCRIPTION:${escapeText(`Через ${opts.alarmMinutes} мин: ${summary}`)}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function icsFileName(title: string, from: LocalDate): string {
  return `${title.replace(/[^\p{L}\p{N}-]+/gu, "_")}_${from}.ics`;
}
