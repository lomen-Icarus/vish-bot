/**
 * Online lessons ("вебинары") from tt.chuvsu.ru/webinar.
 *
 * This page is the only part of the portal that a guest session can read which
 * names teachers: every row has the teacher (with position and degree), the
 * groups, the slot and the topic of that particular session. Group timetable
 * pages carry none of that, so the bot uses these rows for three things:
 * enriching distance reminders, answering "кто такая …" without a portal
 * account, and the teacher search fallback.
 *
 * The page also lists ad-hoc webinars (meetings, external events) that are not
 * lessons at all; only rows marked as "по расписанию" are matched to lessons.
 */
import type { Webinar } from "chuvsu-js";
import type { PortalClient } from "./client.js";
import type { Repo, WebinarRow } from "../db/repo.js";
import { teacherMatch } from "./teachers.js";
import { addDays, todayMsk, type LocalDate } from "../time.js";
import { logger } from "../logger.js";

/** A teacher as seen through the webinar page: no portal id, but real data. */
export interface WebinarTeacher {
  name: string;
  position: string | null;
  degree: string | null;
  subjects: string[];
  groups: string[];
  lessons: WebinarRow[];
}

const REFRESH_TTL_MS = 55 * 60_000;
/** How many days ahead the hourly refresh keeps warm. */
export const REFRESH_DAYS = 6;

function minutes(t: { hours: number; minutes: number } | undefined): number | null {
  return t ? t.hours * 60 + t.minutes : null;
}

export function webinarToRow(w: Webinar, fallbackDate: LocalDate): WebinarRow {
  return {
    date: w.scheduledDate ?? fallbackDate,
    slot: w.slotNumber ?? null,
    start: minutes(w.time?.start),
    end: minutes(w.time?.end),
    subject: w.subject.trim(),
    type: w.type.trim(),
    teacher: w.teacher?.name?.trim() ?? "",
    position: w.teacher?.position?.trim() || null,
    degree: w.teacher?.degree?.trim() || null,
    subgroup: w.subgroup ?? null,
    title: w.title?.trim() || null,
    groups: w.groups.map((g) => g.trim()).filter(Boolean),
    scheduled: w.scheduled !== false,
  };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** "ВИШ-12-23иот (ИОТ)" and "ВИШ-12-23" describe the same students. */
function sameGroup(a: string, b: string): boolean {
  const clean = (x: string) => norm(x).replace(/\s*\(.*?\)\s*/g, "").replace(/иот$/, "").replace(/\s*ин$/, "").trim();
  return clean(a) === clean(b);
}

interface LessonLike {
  date: LocalDate;
  slot: number | null;
  start: number | null;
  subject: string;
  subgroup: number | null;
}

/**
 * Does this webinar row describe the given lesson? Slots and start times must
 * agree whenever both sides know them, which is what keeps an ad-hoc 18:00
 * webinar away from an 08:20 lesson of the same subject.
 */
function matches(r: WebinarRow, lesson: LessonLike, groupNames: string[], subject: string): boolean {
  if (!r.scheduled) return false;
  if (norm(r.subject) !== subject) return false;
  if (lesson.slot != null && r.slot != null && r.slot !== lesson.slot) return false;
  if (lesson.start != null && r.start != null && r.start !== lesson.start) return false;
  // Neither side pinned the time: too weak to attach a teacher to.
  if ((lesson.slot == null || r.slot == null) && (lesson.start == null || r.start == null)) return false;
  return groupNames.some((g) => r.groups.some((rg) => sameGroup(rg, g)));
}

/** Of several candidates, prefer the one whose subgroup matches (or has none). */
function pick(candidates: WebinarRow[], subgroup: number | null): WebinarRow | null {
  if (!candidates.length) return null;
  const exact = candidates.find((r) => r.subgroup === subgroup);
  if (exact) return exact;
  const whole = candidates.find((r) => r.subgroup == null);
  if (whole) return whole;
  if (subgroup == null) {
    // Rows disagree about the subgroup and the lesson does not say: only use
    // them when they agree on what matters.
    const first = candidates[0]!;
    const same = candidates.every((r) => r.teacher === first.teacher && r.title === first.title);
    return same ? first : null;
  }
  return null;
}

export class WebinarService {
  private lastRefresh = new Map<LocalDate, number>();
  /** Rows per day, so a reminder tick does not re-read the table per lesson. */
  private cache = new Map<LocalDate, WebinarRow[]>();
  private teacherCache: { at: number; list: WebinarTeacher[] } | null = null;

  constructor(
    private readonly portal: PortalClient,
    private readonly repo: Repo,
    private readonly facultyId: number,
  ) {}

  private rowsOn(date: LocalDate): WebinarRow[] {
    let rows = this.cache.get(date);
    if (!rows) {
      rows = this.repo.webinarsBetween(date, date);
      this.cache.set(date, rows);
    }
    return rows;
  }

  private invalidate(date?: LocalDate): void {
    if (date) this.cache.delete(date);
    else this.cache.clear();
    this.teacherCache = null;
  }

  /** Fetch and store the webinars of the given days (skipping days refreshed recently). */
  async refresh(dates: LocalDate[], opts: { force?: boolean } = {}): Promise<number> {
    let stored = 0;
    for (const date of dates) {
      const last = this.lastRefresh.get(date) ?? 0;
      if (!opts.force && Date.now() - last < REFRESH_TTL_MS) continue;
      try {
        const list = await this.portal.getWebinars(date, this.facultyId);
        const all = list.map((w) => webinarToRow(w, date));
        // The page is about one day; a row dated otherwise would leak past the
        // delete of that day and pile up on every refresh.
        const rows = all.filter((r) => r.date === date && r.teacher && r.subject);
        const skipped = all.length - rows.length;
        if (skipped) logger.debug({ date, skipped }, "webinar rows skipped (other date or no teacher)");
        this.repo.replaceWebinars(date, rows);
        this.invalidate(date);
        this.lastRefresh.set(date, Date.now());
        stored += rows.length;
      } catch (err) {
        logger.warn({ err: String(err), date }, "webinar page fetch failed");
      }
    }
    // Keep the bookkeeping bounded on a long-running process.
    const horizon = addDays(todayMsk(), -1);
    for (const date of [...this.lastRefresh.keys()]) if (date < horizon) this.lastRefresh.delete(date);
    for (const date of [...this.cache.keys()]) if (date < horizon) this.cache.delete(date);
    if (stored) logger.info({ stored, dates: dates.length }, "webinars refreshed");
    return stored;
  }

  /** Refresh today plus the next `days` days; called hourly and at startup. */
  refreshUpcoming(days = REFRESH_DAYS): Promise<number> {
    const today = todayMsk();
    return this.refresh(Array.from({ length: days + 1 }, (_, i) => addDays(today, i)));
  }

  /** The webinar matching a concrete lesson, if the portal listed one. */
  forLesson(lesson: LessonLike, groupNames: string[]): WebinarRow | null {
    const subject = norm(lesson.subject);
    return pick(
      this.rowsOn(lesson.date).filter((r) => matches(r, lesson, groupNames, subject)),
      lesson.subgroup,
    );
  }

  /**
   * Copy of the lessons with the teacher and the session topic filled in from
   * the webinar page. Display only: change detection keeps using the raw data.
   */
  enrich<T extends { date: LocalDate; slot: number | null; start: number | null; subject: string; subgroup: number | null; isDistance: boolean; teacher: string | null; topic?: string }>(lessons: T[], groupNames: string[]): T[] {
    if (!lessons.some((l) => l.isDistance)) return lessons;
    return lessons.map((l) => {
      if (!l.isDistance) return l;
      const hit = this.forLesson(l, groupNames);
      if (!hit) return l;
      return { ...l, teacher: l.teacher ?? hit.teacher, topic: hit.title ?? undefined };
    });
  }

  /** Everything the webinar history knows about teachers, newest lessons first. */
  teachers(fromDate?: LocalDate): WebinarTeacher[] {
    if (!fromDate && this.teacherCache && Date.now() - this.teacherCache.at < 5 * 60_000) return this.teacherCache.list;
    const from = fromDate ?? addDays(todayMsk(), -60);
    const rows = this.repo.webinarsBetween(from, addDays(todayMsk(), 30));
    const byName = new Map<string, WebinarTeacher>();
    for (const r of rows) {
      if (!r.teacher) continue;
      const key = norm(r.teacher);
      const entry = byName.get(key) ?? { name: r.teacher, position: r.position, degree: r.degree, subjects: [], groups: [], lessons: [] };
      entry.position ??= r.position;
      entry.degree ??= r.degree;
      if (!entry.subjects.includes(r.subject)) entry.subjects.push(r.subject);
      for (const g of r.groups) if (!entry.groups.includes(g)) entry.groups.push(g);
      entry.lessons.push(r);
      byName.set(key, entry);
    }
    for (const t of byName.values()) t.lessons.sort((a, b) => b.date.localeCompare(a.date) || (b.slot ?? 0) - (a.slot ?? 0));
    const list = [...byName.values()];
    if (!fromDate) this.teacherCache = { at: Date.now(), list };
    return list;
  }

  /** Fuzzy teacher lookup over the webinar history (same scoring as the portal directory). */
  search(query: string, limit = 5): WebinarTeacher[] {
    return this.searchScored(query, limit).map((x) => x.teacher);
  }

  /** То же, но видно, какие совпадения нашлись только с опечаткой. */
  searchScored(query: string, limit = 5): Array<{ teacher: WebinarTeacher; score: number; fuzzy: boolean }> {
    return this.teachers()
      .map((t) => ({ teacher: t, ...teacherMatch(t.name, query) }))
      .filter((x) => x.score > 0)
      // Exact matches first; typo-tolerant ones only fill the rest of the list.
      .sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy) || b.score - a.score || a.teacher.name.localeCompare(b.teacher.name, "ru"))
      .slice(0, limit);
  }

  /** Upcoming online lessons of a teacher (today and later). */
  upcoming(teacher: WebinarTeacher, limit = 10): WebinarRow[] {
    const today = todayMsk();
    return teacher.lessons
      .filter((l) => l.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.slot ?? 0) - (b.slot ?? 0))
      .slice(0, limit);
  }

  /** How far ahead the stored data reaches; shown in /health. */
  stats(): { rows: number; days: number; teachers: number; until: LocalDate | null } {
    const dates = this.repo.webinarDates();
    const rows = dates.length ? this.repo.webinarsBetween(dates[0]!, dates[dates.length - 1]!) : [];
    return {
      rows: rows.length,
      days: dates.length,
      teachers: new Set(rows.filter((r) => r.teacher).map((r) => norm(r.teacher))).size,
      until: dates.length ? dates[dates.length - 1]! : null,
    };
  }
}
