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

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,;:()"'«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score how well a directory entry ("Иванова И.И." / "Иванова Ирина Ивановна")
 * matches a typed query ("иванова", "Ирина Иванова", "иванова и", "иван").
 * Words may come in any order; a one-letter name word is an initial and
 * matches any query word starting with it. 0 = no match, higher = better.
 */
export function teacherMatchScore(name: string, query: string): number {
  const q = norm(query).split(" ").filter((w) => w.length >= 1);
  const n = norm(name).split(" ").filter(Boolean);
  if (!q.length || !n.length) return 0;
  const surname = n[0]!;
  let score = 0;
  // At least one query word must match a real name word: matching only initials
  // ("Троишестова" against the "Т." of "Кожина Т. Н.") is not a match at all.
  let substantive = false;
  const used = new Set<number>();
  for (const qw of q) {
    let best = 0;
    let bestIdx = -1;
    n.forEach((nw, i) => {
      if (used.has(i)) return;
      let s = 0;
      if (nw === qw) s = i === 0 ? 6 : 4;
      else if (nw.length === 1 && qw.startsWith(nw)) s = 1; // initial
      else if (qw.length === 1 && nw.startsWith(qw)) s = 1; // typed initial
      else if (nw.startsWith(qw) && qw.length >= 2) s = i === 0 ? 5 : 3;
      else if (qw.startsWith(nw) && nw.length >= 3) s = 2; // typed a longer form ("иванова" vs "иванов")
      else if (qw.length >= 4 && nw.includes(qw)) s = 1;
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    });
    if (best === 0) return 0; // every query word must match something
    used.add(bestIdx);
    score += best;
    // Matching an initial (a one-letter name word) never counts as substantive,
    // even when it is exact: "к ю" must not match every "… К. Ю." in the directory.
    if (best >= 2 && qw.length >= 2 && (n[bestIdx]?.length ?? 0) >= 2) substantive = true;
  }
  if (!substantive) return 0;
  if (q.length === 1 && q[0]!.length >= 3 && surname.startsWith(q[0]!)) score += 2;
  return score;
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

  /** Fuzzy search over the directory (any word order, initials), then the portal's own search. */
  async search(query: string, limit = 8): Promise<TeacherRef[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const dir = await this.directory();
    const scored = dir
      .map((t) => ({ t, s: teacherMatchScore(t.name, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name, "ru"));
    if (scored.length) return scored.slice(0, limit).map((x) => x.t);
    // Portal search understands surnames only: try the longest word (usually the surname).
    const surname = norm(q)
      .split(" ")
      .sort((a, b) => b.length - a.length)[0]!;
    try {
      const found = await this.portal.searchTeachers(surname);
      if (found.length) {
        // Remember them so the next lookup is local.
        const merged = [...dir];
        for (const f of found) if (!merged.some((t) => t.id === f.id)) merged.push(f);
        this.repo.setMeta("teachers:list", JSON.stringify(merged));
      }
      const rescored = found.map((t) => ({ t, s: teacherMatchScore(t.name, q) })).sort((a, b) => b.s - a.s);
      return (rescored.some((x) => x.s > 0) ? rescored.filter((x) => x.s > 0) : rescored).slice(0, limit).map((x) => x.t);
    } catch (err) {
      this.repo.setMeta("teachers:lastError", String(err).slice(0, 300));
      logger.warn({ err: String(err) }, "portal teacher search failed");
      return [];
    }
  }

  async byId(id: number): Promise<TeacherRef | null> {
    const dir = await this.directory();
    return dir.find((t) => t.id === id) ?? null;
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
