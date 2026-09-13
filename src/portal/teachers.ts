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
          logger.info({ count: list.length }, "teacher directory refreshed");
          return list;
        }
        return cached;
      } catch (err) {
        logger.warn({ err: String(err) }, "teacher directory refresh failed");
        return cached;
      } finally {
        this.directoryPromise = null;
      }
    })();
    return this.directoryPromise;
  }

  /** Case-insensitive surname/initials search over the directory (portal search as a fallback). */
  async search(query: string, limit = 8): Promise<TeacherRef[]> {
    const q = query.trim().toLowerCase().replace(/ё/g, "е");
    if (q.length < 2) return [];
    const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
    const dir = await this.directory();
    const starts = dir.filter((t) => norm(t.name).startsWith(q));
    const contains = dir.filter((t) => !norm(t.name).startsWith(q) && norm(t.name).includes(q));
    const local = [...starts, ...contains].slice(0, limit);
    if (local.length || dir.length) return local;
    try {
      return (await this.portal.searchTeachers(query)).slice(0, limit);
    } catch (err) {
      logger.warn({ err: String(err) }, "portal teacher search failed");
      return [];
    }
  }

  async byId(id: number): Promise<TeacherRef | null> {
    const dir = await this.directory();
    return dir.find((t) => t.id === id) ?? null;
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
