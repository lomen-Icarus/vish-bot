/**
 * Teacher schedules. The portal shows them (and the teacher directory) only to
 * signed-in accounts, so this service runs on a separate, credentialed client.
 * The directory is cached in the database for a day; schedule pages for 15 min.
 */
import type { PortalClient } from "./client.js";
import type { Repo } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import { mergeVariants } from "../schedule/merge.js";
import { expandDays } from "../schedule/expand.js";
import { SEMESTER_WEEKS } from "../schedule/service.js";
import type { Occurrence } from "../schedule/model.js";
import type { LocalDate } from "../time.js";
import { logger } from "../logger.js";
import type { ParsedScheduleDay } from "chuvsu-js/parsers";
import { nameMatch, nameMatchScore, normName, type NameMatch } from "../text/match.js";

export interface TeacherRef {
  id: number;
  name: string;
}

const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_TTL_MS = 15 * 60 * 1000;

interface CachedPage {
  fetchedAt: number;
  days: ParsedScheduleDay[];
  fullName: string | null;
}

/** Normalised words of a query, used for the portal's own search box. */
function norm(s: string): string {
  return normName(s);
}

/**
 * Score how well a directory entry matches a typed query, typos included.
 * Kept as a named export: the webinar directory scores its teachers the same way.
 */
export function teacherMatchScore(name: string, query: string): number {
  return nameMatchScore(name, query);
}

/** Same, but says whether the match needed typo tolerance. */
export function teacherMatch(name: string, query: string): NameMatch {
  return nameMatch(name, query);
}

export class TeacherService {
  private readonly pages = new Map<string, CachedPage>();
  private directoryPromise: Promise<TeacherRef[]> | null = null;

  constructor(
    private readonly portal: PortalClient,
    private readonly repo: Repo,
    private readonly schedule: ScheduleService,
  ) {}

  /** Teacher directory, refreshed daily. Falls back to the stale copy on network errors. */
  async directory(): Promise<TeacherRef[]> {
    const raw = this.repo.getMeta("teachers:list");
    const at = Number(this.repo.getMeta("teachers:fetchedAt") ?? 0);
    const cached = raw ? (JSON.parse(raw) as TeacherRef[]) : [];
    if (cached.length && Date.now() - at < DIRECTORY_TTL_MS) return cached;
    if (this.directoryPromise) return this.directoryPromise;
    this.directoryPromise = (async () => {
      try {
        const list = await this.portal.getAllTeachers();
        if (list.length) {
          this.repo.setMeta("teachers:list", JSON.stringify(list));
          this.repo.setMeta("teachers:fetchedAt", String(Date.now()));
          this.repo.setMeta("teachers:lastError", "");
          logger.info({ count: list.length }, "teacher directory refreshed");
          return list;
        }
        this.repo.setMeta("teachers:lastError", "справочник /index/tech пуст — портал не отдал список (учётка не авторизована?)");
        logger.warn("teacher directory came back empty");
        return cached;
      } catch (err) {
        this.repo.setMeta("teachers:lastError", String(err).slice(0, 300));
        logger.warn({ err: String(err) }, "teacher directory refresh failed");
        return cached;
      } finally {
        this.directoryPromise = null;
      }
    })();
    return this.directoryPromise;
  }

  /** Fuzzy search over the directory (any word order, initials, typos), then the portal's own search. */
  async search(query: string, limit = 8): Promise<TeacherRef[]> {
    return (await this.searchScored(query, limit)).map((x) => x.ref);
  }

  /**
   * Same as `search`, but keeps the score and whether the match needed typo
   * tolerance, so the caller can offer "может быть, ты имел в виду…" instead of
   * opening someone else's timetable.
   */
  async searchScored(query: string, limit = 8): Promise<Array<{ ref: TeacherRef; score: number; fuzzy: boolean }>> {
    const q = query.trim();
    if (q.length < 2) return [];
    const dir = await this.directory();
    const scored = dir
      .map((t) => ({ ref: t, ...nameMatch(t.name, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy) || b.score - a.score || a.ref.name.localeCompare(b.ref.name, "ru"));
    // Точные попадания — ответ. Если совпало только с опечаткой, всё равно
    // спросим портал: там может найтись тот, кого в суточном кеше ещё нет.
    if (scored.some((x) => !x.fuzzy)) return scored.slice(0, limit);
    // The portal search box understands a surname. People type it first
    // ("Троишестова Дарья"), so try that word first and only then the others,
    // longest first, until the portal returns something.
    const words = norm(q).split(" ").filter((w) => w.length >= 3);
    const candidates = [...new Set([words[0], ...words.slice(1).sort((a, b) => b.length - a.length)].filter(Boolean) as string[])];
    for (const word of candidates) {
      try {
        const found = await this.portal.searchTeachers(word);
        if (!found.length) continue;
        // Remember them so the next lookup is local.
        const merged = [...dir];
        for (const f of found) if (!merged.some((t) => t.id === f.id)) merged.push(f);
        this.repo.setMeta("teachers:list", JSON.stringify(merged));
        const rescored = found.map((t) => ({ ref: t, ...nameMatch(t.name, q) })).sort((a, b) => b.score - a.score);
        const hits = rescored.filter((x) => x.score > 0);
        return (hits.length ? hits : rescored.map((x) => ({ ...x, score: 1, fuzzy: true }))).slice(0, limit);
      } catch (err) {
        this.repo.setMeta("teachers:lastError", String(err).slice(0, 300));
        logger.warn({ err: String(err), word }, "portal teacher search failed");
        return scored.slice(0, limit);
      }
    }
    return scored.slice(0, limit);
  }

  async byId(id: number): Promise<TeacherRef | null> {
    const dir = await this.directory();
    return dir.find((t) => t.id === id) ?? null;
  }

  /**
   * Prove the portal account can actually sign in, so a wrong password shows up
   * in the log and in /health instead of silently emptying the teacher section.
   */
  async checkLogin(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.portal.login();
      const list = await this.portal.getAllTeachers();
      if (!list.length) {
        const msg = "вход прошёл, но справочник преподавателей пуст: учётка не видит /index/tech";
        this.repo.setMeta("teachers:loginOk", "0");
        this.repo.setMeta("teachers:lastError", msg);
        return { ok: false, error: msg };
      }
      this.repo.setMeta("teachers:list", JSON.stringify(list));
      this.repo.setMeta("teachers:fetchedAt", String(Date.now()));
      this.repo.setMeta("teachers:loginOk", "1");
      this.repo.setMeta("teachers:lastError", "");
      return { ok: true };
    } catch (err) {
      const msg = String(err).slice(0, 300);
      this.repo.setMeta("teachers:loginOk", "0");
      this.repo.setMeta("teachers:lastError", msg);
      return { ok: false, error: msg };
    }
  }

  loginOk(): boolean | null {
    const v = this.repo.getMeta("teachers:loginOk");
    return v == null || v === "" ? null : v === "1";
  }

  lastError(): string | null {
    const e = this.repo.getMeta("teachers:lastError");
    return e ? e : null;
  }

  private async page(teacherId: number, period: 1 | 2 | 3 | 4): Promise<CachedPage> {
    const key = `${teacherId}:${period}`;
    const cached = this.pages.get(key);
    if (cached && Date.now() - cached.fetchedAt < PAGE_TTL_MS) return cached;
    const { days, info } = await this.portal.getTeacherPage(teacherId, period);
    const entry: CachedPage = { fetchedAt: Date.now(), days, fullName: info?.name ?? null };
    this.pages.set(key, entry);
    return entry;
  }

  /** Concrete lessons of a teacher for [from, to] (semester + session of the semester). */
  async lessons(teacher: TeacherRef, from: LocalDate, to: LocalDate): Promise<{ lessons: Occurrence[]; fullName: string | null }> {
    const semester = this.schedule.semesterFor(from);
    const anchor = this.schedule.weekOneMonday(semester);
    const out: Occurrence[] = [];
    let fullName: string | null = null;
    const sem = await this.page(teacher.id, semester);
    fullName = sem.fullName;
    if (anchor) {
      out.push(...expandDays(mergeVariants([{ name: teacher.name, days: sem.days }]), { groupKey: `teacher:${teacher.id}`, period: semester, weekOneMonday: anchor, weekCount: SEMESTER_WEEKS, from, to }));
    }
    try {
      const ses = await this.page(teacher.id, this.schedule.sessionFor(semester));
      out.push(...expandDays(mergeVariants([{ name: teacher.name, days: ses.days }]), { groupKey: `teacher:${teacher.id}`, period: this.schedule.sessionFor(semester), weekOneMonday: anchor ?? from, from, to }));
    } catch (err) {
      logger.debug({ err: String(err) }, "teacher session page unavailable");
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || (a.slot ?? 0) - (b.slot ?? 0));
    return { lessons: out, fullName };
  }
}
