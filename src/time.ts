/**
 * Time helpers. Cheboksary lives in Europe/Moscow (UTC+3, no DST), so all
 * "wall clock" math is done with a fixed offset and plain YYYY-MM-DD strings.
 */
export const MSK_OFFSET_MINUTES = 3 * 60;

/** ISO calendar date, e.g. "2026-09-14". */
export type LocalDate = string;

export interface WallClock {
  date: LocalDate;
  /** Minutes since local midnight. */
  minutes: number;
  /** 1 = Monday ... 7 = Sunday. */
  weekday: number;
  /** Epoch milliseconds of the instant. */
  ms: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function toLocalDate(y: number, m: number, d: number): LocalDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isLocalDate(s: string): s is LocalDate {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Days since epoch for a LocalDate (UTC-based, timezone-free). */
export function dayNumber(date: LocalDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(n: number): LocalDate {
  const dt = new Date(n * DAY_MS);
  return toLocalDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromDayNumber(dayNumber(date) + days);
}

export function diffDays(a: LocalDate, b: LocalDate): number {
  return dayNumber(a) - dayNumber(b);
}

/** 1 = Monday ... 7 = Sunday. */
export function weekdayOf(date: LocalDate): number {
  const dow = new Date(dayNumber(date) * DAY_MS).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - weekdayOf(date));
}

export function wallClock(at: Date = new Date()): WallClock {
  const ms = at.getTime();
  const shifted = new Date(ms + MSK_OFFSET_MINUTES * 60_000);
  const date = toLocalDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { date, minutes, weekday: weekdayOf(date), ms };
}

export function todayMsk(): LocalDate {
  return wallClock().date;
}

/** Epoch ms of a local wall time on a given date. */
export function localToMs(date: LocalDate, minutes: number): number {
  return dayNumber(date) * DAY_MS + (minutes - MSK_OFFSET_MINUTES) * 60_000;
}

export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function fmtHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const WEEKDAY_NAMES = ["", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"] as const;
export const WEEKDAY_SHORT = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"] as const;
const MONTH_GENITIVE = ["", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

export function weekdayName(date: LocalDate): string {
  return WEEKDAY_NAMES[weekdayOf(date)] ?? "";
}

export function weekdayShort(date: LocalDate): string {
  return WEEKDAY_SHORT[weekdayOf(date)] ?? "";
}

/** "14 сентября" */
export function fmtDayMonth(date: LocalDate): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTH_GENITIVE[m]}`;
}

/** "14.09" */
export function fmtDDMM(date: LocalDate): string {
  const [, m, d] = date.split("-") as [string, string, string];
  return `${d}.${m}`;
}

/** "14.09.2026" */
export function fmtDDMMYYYY(date: LocalDate): string {
  const [y, m, d] = date.split("-") as [string, string, string];
  return `${d}.${m}.${y}`;
}

/** Parse "14.09.2026" or "14.09" (current academic year context) into LocalDate. */
export function parseRuDate(input: string, today: LocalDate = todayMsk()): LocalDate | null {
  const m = /^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/.exec(input.trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  if (m[3] && m[3].length === 2) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const candidate = toLocalDate(y, mo, d);
  if (!m[3]) {
    // Without a year pick the nearest occurrence (within +-6 months).
    const diff = diffDays(candidate, today);
    if (diff < -180) return toLocalDate(y + 1, mo, d);
    if (diff > 180) return toLocalDate(y - 1, mo, d);
  }
  return candidate;
}

/**
 * Слова-даты: «сегодня», «завтра», «вчера», «послезавтра», «позавчера».
 * Каждое лишнее «после» двигает день вперёд, каждое «поза» — назад, поэтому
 * «послепослезавтра» — это сегодня + 3, а «позапозавчера» — сегодня − 3.
 * Возвращает смещение в днях или null, если это не слово-дата.
 */
export function parseDayWord(input: string): number | null {
  const w = input.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, "");
  if (!w) return null;
  if (w === "сегодня" || w === "сейчас") return 0;
  const m = /^((?:после|поза)*)(завтра|вчера)$/.exec(w);
  if (!m) return null;
  const base = m[2] === "завтра" ? 1 : -1;
  const prefixes = m[1]!.match(/после|поза/g) ?? [];
  let offset = base;
  for (const p of prefixes) offset += p === "после" ? 1 : -1;
  return offset;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
