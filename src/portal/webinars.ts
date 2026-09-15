/**
 * Online lessons ("вебинары") from tt.chuvsu.ru/webinar.
 *
 * This page is the only part of the portal that a guest session can read which
 * names teachers: every row has the teacher (with position and degree), the
 * groups, the slot and the topic of that particular session. Group timetable
 * pages carry none of that, so the bot uses these rows for three things:
 * enriching distance reminders, answering "кто такая …" without a portal
 * account, and the teacher search fallback.
 */
import type { Webinar } from "chuvsu-js";
import type { PortalClient } from "./client.js";
import type { Repo, WebinarRow } from "../db/repo.js";
import { teacherMatchScore } from "./teachers.js";
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

export class WebinarService {
  private lastRefresh = new Map<LocalDate, number>();

  constructor(
    private readonly portal: PortalClient,
    private readonly repo: Repo,
    private readonly facultyId: number,
  ) {}

  /** Fetch and store the webinars of the given days (skipping days refreshed recently). */
  async refresh(dates: LocalDate[], opts: { force?: boolean } = {}): Promise<number> {
    let stored = 0;
    for (const date of dates) {
      const last = this.lastRefresh.get(date) ?? 0;
      if (!opts.force && Date.now() - last < REFRESH_TTL_MS) continue;
      try {
        const list = await this.portal.getWebinars(date, this.facultyId);
        const rows = list.map((w) => webinarToRow(w, date)).filter((r) => r.teacher || r.subject);
        this.repo.replaceWebinars(date, rows);
        this.lastRefresh.set(date, Date.now());
        stored += rows.length;
      } catch (err) {
        logger.warn({ err: String(err), date }, "webinar page fetch failed");
      }
    }
    if (stored) logger.info({ stored, dates: dates.length }, "webinars refreshed");
    return stored;
  }

  /** Refresh today plus the next `days` days; called hourly and at startup. */
  refreshUpcoming(days = 2): Promise<number> {
    const today = todayMsk();
    return this.refresh(Array.from({ length: days + 1 }, (_, i) => addDays(today, i)));
  }

  /** The webinar matching a concrete lesson, if the portal listed one. */
  forLesson(lesson: { date: LocalDate; slot: number | null; start: number | null; subject: string; subgroup: number | null }, groupNames: string[]): WebinarRow | null {
    const rows = this.repo.webinarsBetween(lesson.date, lesson.date);
    const subject = norm(lesson.subject);
    const candidates = rows.filter((r) => {
      if (lesson.slot != null && r.slot != null && r.slot !== lesson.slot) return false;
      if (lesson.slot == null && lesson.start != null && r.start != null && r.start !== lesson.start) return false;
      if (norm(r.subject) !== subject) return false;
      if (lesson.subgroup != null && r.subgroup != null && r.subgroup !== lesson.subgroup) return false;
      return groupNames.some((g) => r.groups.some((rg) => sameGroup(rg, g)));
    });
    return candidates[0] ?? null;
  }

  /**
   * Copy of the lessons with the teacher and the session topic filled in from
   * the webinar page. Display only: change detection keeps using the raw data.
   */
  enrich<T extends { date: LocalDate; slot: number | null; start: number | null; subject: string; subgroup: number | null; isDistance: boolean; teacher: string | null; topic?: string }>(lessons: T[], groupNames: string[]): T[] {
    const online = lessons.filter((l) => l.isDistance);
    if (!online.length) return lessons;
    const byDate = new Map<LocalDate, WebinarRow[]>();
    for (const date of new Set(online.map((l) => l.date))) byDate.set(date, this.repo.webinarsBetween(date, date));
    return lessons.map((l) => {
      if (!l.isDistance) return l;
      const rows = byDate.get(l.date) ?? [];
      const subject = norm(l.subject);
      const hit = rows.find((r) => {
        if (l.slot != null && r.slot != null && r.slot !== l.slot) return false;
        if (l.slot == null && l.start != null && r.start != null && r.start !== l.start) return false;
        if (norm(r.subject) !== subject) return false;
        if (l.subgroup != null && r.subgroup != null && r.subgroup !== l.subgroup) return false;
        return groupNames.some((g) => r.groups.some((rg) => sameGroup(rg, g)));
      });
      if (!hit) return l;
      return { ...l, teacher: l.teacher ?? hit.teacher ?? null, topic: hit.title ?? undefined };
    });
  }

  /** Everything the webinar history knows about teachers, newest lessons first. */
  teachers(fromDate?: LocalDate): WebinarTeacher[] {
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
    return [...byName.values()];
  }

  /** Fuzzy teacher lookup over the webinar history (same scoring as the portal directory). */
  search(query: string, limit = 5): WebinarTeacher[] {
    return this.teachers()
      .map((t) => ({ t, s: teacherMatchScore(t.name, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name, "ru"))
      .slice(0, limit)
      .map((x) => x.t);
  }

  /** Upcoming online lessons of a teacher (today and later). */
  upcoming(teacher: WebinarTeacher, limit = 10): WebinarRow[] {
    const today = todayMsk();
    return teacher.lessons
      .filter((l) => l.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.slot ?? 0) - (b.slot ?? 0))
      .slice(0, limit);
  }

  stats(): { rows: number; days: number; teachers: number } {
    const dates = this.repo.webinarDates();
    const rows = dates.length ? this.repo.webinarsBetween(dates[0]!, dates[dates.length - 1]!) : [];
    return { rows: rows.length, days: dates.length, teachers: new Set(rows.map((r) => norm(r.teacher))).size };
  }
}
