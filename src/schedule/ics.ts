/**
 * iCalendar export. Phones open an .ics straight from Telegram and offer to
 * add every lesson to the calendar, alarms included, no HTTPS server needed.
 * The same builder feeds the subscription URL (webcal), where calendars
 * refresh themselves.
 *
 * Every lesson has a stable UID (its position: date + slot + subject + type +
 * subgroup), so a re-import or a feed refresh updates the same event instead
 * of adding a twin. SEQUENCE grows with generation time, so a newer copy
 * always wins. Vacated slots (transfers) and removed lessons are emitted as
 * STATUS:CANCELLED with the old UID: subscriptions drop them, Google import
 * ignores them, and iOS import shows them as cancelled.
 */
import { lessonTypeLabel, positionKey, type Occurrence } from "./model.js";
import { localToMs, type LocalDate } from "../time.js";

export interface IcsOptions {
  /** Calendar display name, e.g. "ВИШ-12-23". */
  name: string;
  lessons: Occurrence[];
  /** Lessons that no longer exist at their position (removed / moved away); emitted as cancelled. */
  cancelled?: Occurrence[];
  /** Minutes before the lesson for a VALARM; null = no alarms. */
  alarmMinutes: number | null;
  /** Generation time, for DTSTAMP / SEQUENCE. */
  now?: Date;
  /** Suggested refresh interval for subscribed calendars (ISO 8601 duration). */
  refreshInterval?: string;
  /**
   * Subscription feeds are full snapshots that the calendar re-reads, so every
   * event keeps SEQUENCE 0 and nothing looks "modified" on each refresh.
   * One-off files keep the generation counter, which is what makes a re-import
   * win over the events already in the calendar.
   */
  stableSequence?: boolean;
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

const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);

/** Monotonic per-generation revision: minutes since 2026-01-01. */
export function icsSequence(now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH) / 60_000));
}

export function icsUid(o: Pick<Occurrence, "date" | "slot" | "start" | "subject" | "type" | "subgroup">): string {
  return `${Buffer.from(positionKey(o)).toString("base64url")}@vish-bot`;
}

function eventLines(o: Occurrence, opts: IcsOptions, stamp: string, sequence: number, cancelled: boolean): string[] | null {
  if (o.start == null || o.end == null) return null;
  const startMs = localToMs(o.date, o.start);
  const endMs = localToMs(o.date, o.end);
  const summary = `${o.subject} (${lessonTypeLabel(o.type)})`;
  const desc: string[] = [opts.name];
  if (o.slot != null) desc.push(`${o.slot} пара`);
  if (o.teacher) desc.push(o.teacher);
  if (o.subgroup) desc.push(`${o.subgroup} подгруппа`);
  if (o.movedFrom) desc.push(`перенос с ${o.movedFrom.date}`);
  if (o.isDistance) desc.push("дистанционно");
  if (cancelled) desc.push(o.movedTo ? `перенесена на ${o.movedTo.date}${o.movedTo.slot ? ` (${o.movedTo.slot} пара)` : ""}` : "убрана из расписания");
  const lines = ["BEGIN:VEVENT", `UID:${icsUid(o)}`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, `SEQUENCE:${sequence}`, `DTSTART:${utcStamp(startMs)}`, `DTEND:${utcStamp(endMs)}`];
  lines.push(`SUMMARY:${escapeText(cancelled ? `Отменено: ${summary}` : summary)}`);
  if (o.room && !o.isDistance) lines.push(`LOCATION:${escapeText(`ауд. ${o.room}, ЧувГУ`)}`);
  lines.push(`DESCRIPTION:${escapeText(desc.join(" · "))}`);
  lines.push(`CATEGORIES:${escapeText(lessonTypeLabel(o.type))}`);
  lines.push(`STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`);
  if (!cancelled && opts.alarmMinutes != null && opts.alarmMinutes > 0) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${opts.alarmMinutes}M`, `DESCRIPTION:${escapeText(`Через ${opts.alarmMinutes} мин: ${summary}`)}`, "END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines;
}

export function buildIcs(opts: IcsOptions): string {
  const now = opts.now ?? new Date();
  const stamp = utcStamp(now.getTime());
  const sequence = opts.stableSequence ? 0 : icsSequence(now);
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//vish-bot//Расписание ВИШ ЧувГУ//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeText(opts.name)}`, "X-WR-TIMEZONE:Europe/Moscow"];
  if (opts.refreshInterval) lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${opts.refreshInterval}`, `X-PUBLISHED-TTL:${opts.refreshInterval}`);
  const seen = new Set<string>();
  const push = (o: Occurrence, cancelled: boolean) => {
    const uid = icsUid(o);
    if (seen.has(uid)) return;
    const ev = eventLines(o, opts, stamp, sequence, cancelled);
    if (!ev) return;
    seen.add(uid);
    lines.push(...ev);
  };
  // Live lessons first so a position that is both current and "cancelled" in the input stays live.
  for (const o of opts.lessons) if (o.status === "scheduled") push(o, false);
  for (const o of opts.lessons) if (o.status === "moved") push(o, true);
  for (const o of opts.cancelled ?? []) push(o, true);
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function icsFileName(title: string, from: LocalDate, suffix = ""): string {
  return `${title.replace(/[^\p{L}\p{N}-]+/gu, "_")}_${from}${suffix}.ics`;
}
