import type { ParsedScheduleDay } from "chuvsu-js/parsers";
import type { Repo } from "../db/repo.js";
import type { PortalClient } from "../portal/client.js";
import { logger } from "../logger.js";
import { addDays, mondayOf, todayMsk, type LocalDate } from "../time.js";
import { buildLogicalGroups, logicalKeyFor, type LogicalGroup } from "./groups.js";
import { mergeVariants } from "./merge.js";
import { expandDays } from "./expand.js";
import { diffOccurrences, type ChangeEvent } from "./diff.js";
import { isSessionPeriod, type Occurrence, type Period } from "./model.js";

export interface PollResult {
  groupsTotal: number;
  pagesFetched: number;
  pagesFailed: number;
  groupsChanged: string[];
  events: ChangeEvent[];
  noticeChanged: string | null;
  durationMs: number;
}

export interface WeekInfo {
  week: number | null;
  parity: "odd" | "even" | null;
  semester: 1 | 3;
}

/** Days after "today" that change notifications cover. */
export const NOTIFY_HORIZON_DAYS = 14;
/** Window of materialised occurrences kept as the diff baseline. */
export const BASELINE_PAST_DAYS = 7;
export const BASELINE_FUTURE_DAYS = 35;
export const SEMESTER_WEEKS = 17;

const SESSION_FETCH_IDLE_MS = 6 * 60 * 60 * 1000;

export interface ScheduleServiceOptions {
  facultyId: number;
  /** Upper-cased group prefixes to hide and skip (e.g. ОЗВИШ). */
  hiddenPrefixes?: string[];
}

export class ScheduleService {
  private groupsCache: LogicalGroup[] = [];
  private polling: Promise<PollResult> | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly portal: PortalClient,
    private readonly opts: ScheduleServiceOptions,
  ) {}

  // ---------- academic calendar ----------

  get academicYear(): number {
    const stored = this.repo.getMeta("academicYear");
    if (stored) return Number(stored);
    const t = todayMsk();
    const y = Number(t.slice(0, 4));
    return Number(t.slice(5, 7)) >= 9 ? y : y - 1;
  }

  /** Which semester page a date belongs to (1 = fall, 3 = spring). */
  semesterFor(date: LocalDate): 1 | 3 {
    const month = Number(date.slice(5, 7));
    return month >= 2 && month <= 7 ? 3 : 1;
  }

  sessionFor(semester: 1 | 3): 2 | 4 {
    return semester === 1 ? 2 : 4;
  }

  anchorKey(semester: 1 | 3): string {
    return `anchor:${this.academicYear}:${semester}`;
  }

  /** Monday of academic week 1 for the semester, if calibrated. */
  weekOneMonday(semester: 1 | 3): LocalDate | null {
    return this.repo.getMeta(this.anchorKey(semester));
  }

  weekInfo(date: LocalDate): WeekInfo {
    const semester = this.semesterFor(date);
    const anchor = this.weekOneMonday(semester);
    if (!anchor) return { week: null, parity: null, semester };
    const week = Math.floor((Date.parse(mondayOf(date)) - Date.parse(anchor)) / (7 * 86_400_000)) + 1;
    if (week < 1 || week > SEMESTER_WEEKS + 4) return { week: null, parity: null, semester };
    return { week, parity: week % 2 === 1 ? "odd" : "even", semester };
  }

  // ---------- groups ----------

  private visible(groups: LogicalGroup[]): LogicalGroup[] {
    const hidden = new Set(this.opts.hiddenPrefixes ?? []);
    return groups.filter((g) => !hidden.has(g.prefix.toUpperCase()));
  }

  groups(): LogicalGroup[] {
    if (this.groupsCache.length === 0) {
      const portal = this.repo.listPortalGroups(true);
      this.groupsCache = this.visible(buildLogicalGroups(portal, this.academicYear));
    }
    return this.groupsCache;
  }

  /** Groups of one intake year (two digits), e.g. 23 -> ВИШ-11-23 … ВИШ-14-23. */
  stream(intake: number): LogicalGroup[] {
    return this.groups()
      .filter((g) => g.intake === intake)
      .sort((a, b) => a.number - b.number || a.title.localeCompare(b.title, "ru"));
  }

  /** Distinct intake years that have groups, newest first. */
  intakes(): number[] {
    return [...new Set(this.groups().map((g) => g.intake))].sort((a, b) => b - a);
  }

  group(key: string): LogicalGroup | null {
    const all = this.groups();
    const exact = all.find((g) => g.key === key);
    if (exact) return exact;
    // callback_data у Telegram — 64 байта, и длинный ключ в кнопке приходится
    // обрезать (см. groupCb в keyboards.ts). Принимаем такой обрезок, если он
    // однозначно указывает на одну группу.
    if (!key) return null;
    const byPrefix = all.filter((g) => g.key.startsWith(key));
    return byPrefix.length === 1 ? byPrefix[0]! : null;
  }

  async refreshGroups(): Promise<LogicalGroup[]> {
    const portal = await this.portal.getFacultyGroups(this.opts.facultyId);
    this.repo.upsertPortalGroups(portal.map((g) => ({ id: g.id, name: g.name, groupKey: logicalKeyFor(g.name) })));
    this.groupsCache = this.visible(buildLogicalGroups(portal, this.academicYear));
    return this.groupsCache;
  }

  // ---------- materialisation ----------

  private pagesFor(group: LogicalGroup, period: Period): Array<{ name: string; days: ParsedScheduleDay[] }> {
    const nameById = new Map(group.portalIds.map((id, i) => [id, group.portalNames[i] ?? String(id)]));
    return this.repo.pagesForGroup(group.portalIds, period).map((p) => ({ name: nameById.get(p.portalGroupId) ?? String(p.portalGroupId), days: p.parsed as ParsedScheduleDay[] }));
  }

  /** Concrete lessons of a logical group for [from, to], from the stored pages (no network). */
  materialize(group: LogicalGroup, from: LocalDate, to: LocalDate): Occurrence[] {
    const out: Occurrence[] = [];
    const semesters = new Set<1 | 3>();
    for (let d = from; d <= to; d = addDays(d, 1)) semesters.add(this.semesterFor(d));
    for (const semester of semesters) {
      const anchor = this.weekOneMonday(semester);
      const semPages = this.pagesFor(group, semester);
      if (anchor && semPages.length) {
        out.push(...expandDays(mergeVariants(semPages), { groupKey: group.key, period: semester, weekOneMonday: anchor, weekCount: SEMESTER_WEEKS, from, to }));
      }
      const session = this.sessionFor(semester);
      const sesPages = this.pagesFor(group, session);
      if (sesPages.length) {
        out.push(...expandDays(mergeVariants(sesPages), { groupKey: group.key, period: session, weekOneMonday: anchor ?? from, from, to }));
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || (a.slot ?? 0) - (b.slot ?? 0) || (a.subgroup ?? 0) - (b.subgroup ?? 0));
    return out;
  }

  lessonsOn(group: LogicalGroup, date: LocalDate): Occurrence[] {
    return this.materialize(group, date, date);
  }

  // ---------- polling ----------

  poll(opts: { force?: boolean } = {}): Promise<PollResult> {
    if (this.polling) return this.polling;
    this.polling = this.doPoll(opts).finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private shouldFetchSession(today: LocalDate): boolean {
    const md = today.slice(5);
    const inWindow = md >= "11-25" || md <= "02-10" || (md >= "05-10" && md <= "07-20");
    if (inWindow) return true;
    const last = this.repo.getMeta("sessionFetchedAt");
    return !last || Date.now() - Date.parse(last) > SESSION_FETCH_IDLE_MS;
  }

  private async doPoll(opts: { force?: boolean }): Promise<PollResult> {
    const started = Date.now();
    const runId = this.repo.startPollRun();
    const today = todayMsk();
    const result: PollResult = { groupsTotal: 0, pagesFetched: 0, pagesFailed: 0, groupsChanged: [], events: [], noticeChanged: null, durationMs: 0 };
    try {
      const groups = await this.refreshGroups();
      result.groupsTotal = groups.length;
      const semester = this.semesterFor(today);
      const periods: Period[] = [semester];
      const fetchSession = this.shouldFetchSession(today);
      if (fetchSession) periods.push(this.sessionFor(semester));

      const changedGroups = new Set<string>();
      let banner: string | null | undefined;
      let calibrated = false;

      for (const group of groups) {
        for (let i = 0; i < group.portalIds.length; i++) {
          const portalId = group.portalIds[i]!;
          for (const period of periods) {
            let page;
            try {
              page = await this.portal.getGroupPage(portalId, period);
            } catch (err) {
              result.pagesFailed++;
              logger.warn({ err: String(err), portalId, period }, "group page failed, skipping");
              continue;
            }
            result.pagesFetched++;
            if (page.academicYear && String(page.academicYear) !== this.repo.getMeta("academicYear")) {
              this.repo.setMeta("academicYear", String(page.academicYear));
              this.groupsCache = [];
            }
            if (banner === undefined) banner = page.banner;
            if (!calibrated && page.weekMarker && !isSessionPeriod(period)) {
              const marker = page.weekMarker;
              const sem = marker.semester ?? semester;
              const anchor = addDays(mondayOf(today), -(marker.week - 1) * 7);
              const prev = this.repo.getMeta(this.anchorKey(sem));
              if (prev !== anchor) {
                logger.info({ semester: sem, week: marker.week, anchor, prev }, "calibrated academic week anchor");
                this.repo.setMeta(this.anchorKey(sem), anchor);
                if (prev) for (const g of groups) changedGroups.add(g.key);
              }
              if (marker.parity && (marker.week % 2 === 0 ? "even" : "odd") !== marker.parity) {
                logger.warn({ marker }, "portal week parity disagrees with week number");
              }
              calibrated = true;
            }
            const stored = this.repo.getPage(portalId, period);
            const changed = !stored || stored.htmlHash !== page.htmlHash;
            const contentChanged = !stored || JSON.stringify(stored.parsed) !== JSON.stringify(page.days);
            if (changed) this.repo.savePage(portalId, period, page.htmlHash, page.days, contentChanged);
            if (contentChanged) changedGroups.add(group.key);
          }
        }
      }
      if (fetchSession && result.pagesFailed === 0) this.repo.setMeta("sessionFetchedAt", new Date().toISOString());
      if (result.pagesFetched === 0) throw new Error(`No pages fetched (${result.pagesFailed} failures)`);

      // Portal notice banner.
      if (banner !== undefined) {
        const prevBanner = this.repo.getMeta("banner");
        if ((prevBanner ?? "") !== (banner ?? "")) {
          this.repo.setMeta("banner", banner ?? "");
          if (prevBanner !== null) {
            result.noticeChanged = banner ?? "";
            this.repo.insertChangeEvents([{ groupKey: "*", date: today, period: semester, kind: "notice", payload: { text: banner ?? "" } }]);
          }
        }
      }

      // Re-materialise changed groups and diff against the baseline.
      const from = addDays(today, -BASELINE_PAST_DAYS);
      const to = addDays(today, BASELINE_FUTURE_DAYS);
      for (const group of groups) {
        const hasBaseline = this.repo.hasOccurrences(group.key);
        if (!changedGroups.has(group.key) && hasBaseline && !opts.force) continue;
        const next = this.materialize(group, from, to);
        if (hasBaseline) {
          const prev = this.repo.occurrences(group.key, from, to);
          const events = diffOccurrences(prev, next, { from: today, to: addDays(today, NOTIFY_HORIZON_DAYS) });
          if (events.length) {
            result.events.push(...events);
            result.groupsChanged.push(group.key);
            this.repo.insertChangeEvents(
              events.map((e) => ({ groupKey: e.groupKey, date: e.date, period: e.period, kind: e.kind, payload: { before: e.before, after: e.after, fields: e.fields } })),
            );
          }
        }
        this.repo.replaceOccurrences(group.key, from, to, next);
      }

      result.durationMs = Date.now() - started;
      this.repo.finishPollRun(runId, {
        ok: result.pagesFailed === 0,
        groupsTotal: result.groupsTotal,
        groupsChanged: result.groupsChanged.length,
        events: result.events.length,
        error: result.pagesFailed ? `${result.pagesFailed} page(s) failed` : undefined,
      });
      logger.info({ ...result, events: result.events.length }, "poll finished");
      return result;
    } catch (err) {
      result.durationMs = Date.now() - started;
      this.repo.finishPollRun(runId, { ok: false, groupsTotal: result.groupsTotal, groupsChanged: result.groupsChanged.length, events: result.events.length, error: String(err) });
      throw err;
    }
  }
}
