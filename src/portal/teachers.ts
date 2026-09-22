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
import { addDays, todayMsk, type LocalDate } from "../time.js";
import { logger } from "../logger.js";
import type { ParsedScheduleDay } from "chuvsu-js/parsers";
import { nameMatch, nameMatchScore, normName, type NameMatch } from "../text/match.js";
import { createHash } from "node:crypto";
import { parseGroupName } from "../schedule/groups.js";
import type { TeacherMapRow } from "../db/repo.js";

export interface TeacherRef {
  id: number;
  name: string;
}

const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_TTL_MS = 15 * 60 * 1000;
const MAP_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPage {
  fetchedAt: number;
  days: ParsedScheduleDay[];
  fullName: string | null;
  /** Карточка преподавателя: кафедра, степень и адрес фото. */
  info: { name: string; degree?: string; department?: string; photoUrl?: string } | null;
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

/** Ключ в карте: у портальных преподавателей — id, у «дистантных» — хэш имени. */
export function teacherMapKey(teacherId: number | null, name: string): string {
  if (teacherId != null) return `t${teacherId}`;
  return `w${createHash("sha1").update(normName(name)).digest("base64url").slice(0, 12)}`;
}

/** Группа ВИШ? Смотрим только на префикс названия — этого хватает и для ОЗВИШ. */
export function isVishGroupTitle(title: string): boolean {
  const p = parseGroupName(title);
  return !!p && (p.prefix === "ВИШ" || p.prefix === "ОЗВИШ");
}

export class TeacherService {
  private readonly pages = new Map<string, CachedPage>();
  private directoryPromise: Promise<TeacherRef[]> | null = null;
  private mapCache: { at: number; rows: TeacherMapRow[] } | null = null;

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
    const now = Date.now();
    // Ночной обход справочника заводит запись на каждого преподавателя ЧувГУ,
    // а отдаём мы страницу только 15 минут. Без уборки разобранные семестровые
    // расписания всего университета лежат в памяти до перезапуска процесса.
    for (const [k, v] of this.pages) if (now - v.fetchedAt >= PAGE_TTL_MS) this.pages.delete(k);
    const entry: CachedPage = { fetchedAt: now, days, fullName: info?.name ?? null, info: info ?? null };
    this.pages.set(key, entry);
    return entry;
  }

  /** Concrete lessons of a teacher for [from, to] (semester + session of the semester). */
  async lessons(teacher: TeacherRef, from: LocalDate, to: LocalDate): Promise<{ lessons: Occurrence[]; fullName: string | null }> {
    const out: Occurrence[] = [];
    let fullName: string | null = null;
    // Диапазон может пересекать границу семестров (конец января, начало
    // сентября): берём все семестры, которые в него попадают, как это делает
    // ScheduleService.materialize. Иначе дни «за границей» молча пропадали.
    const semesters = new Set<1 | 3>();
    for (let d = from; d <= to; d = addDays(d, 1)) semesters.add(this.schedule.semesterFor(d));
    for (const semester of semesters) {
      const anchor = this.schedule.weekOneMonday(semester);
      const sem = await this.page(teacher.id, semester);
      fullName ??= sem.fullName;
      if (anchor) {
        out.push(...expandDays(mergeVariants([{ name: teacher.name, days: sem.days }]), { groupKey: `teacher:${teacher.id}`, period: semester, weekOneMonday: anchor, weekCount: SEMESTER_WEEKS, from, to }));
      }
      try {
        const session = this.schedule.sessionFor(semester);
        const ses = await this.page(teacher.id, session);
        out.push(...expandDays(mergeVariants([{ name: teacher.name, days: ses.days }]), { groupKey: `teacher:${teacher.id}`, period: session, weekOneMonday: anchor ?? from, from, to }));
      } catch (err) {
        logger.debug({ err: String(err) }, "teacher session page unavailable");
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || (a.slot ?? 0) - (b.slot ?? 0));
    return { lessons: out, fullName };
  }

  // ---- карта «кто из преподавателей ведёт у ВИШ» ----

  /**
   * Обновляет карту по одному преподавателю: тянет его семестровую страницу и
   * смотрит, есть ли среди его групп группы ВИШ. Портал — медленный, поэтому
   * это делается фоном и понемногу.
   */
  async refreshMapFor(teacherId: number, fallbackName?: string): Promise<TeacherMapRow | null> {
    const semester = this.schedule.semesterFor(todayMsk());
    try {
      const page = await this.page(teacherId, semester);
      const groups = new Set<string>();
      const subjects = new Set<string>();
      for (const day of page.days) {
        for (const block of day.blocks ?? []) {
          for (const lesson of block.lessons ?? []) {
            if (lesson.subject) subjects.add(lesson.subject);
            for (const g of lesson.groups ?? []) groups.add(g);
          }
        }
      }
      const vishGroups = [...groups].filter(isVishGroupTitle);
      const key = teacherMapKey(teacherId, page.fullName ?? fallbackName ?? String(teacherId));
      // Тот же человек мог прийти со страницы вебинаров (ключ по имени) — там
      // уже известно, что он наш. Не теряем это, если сейчас у него пар нет.
      const fromWebinars = this.repo.teacherMapByKey(teacherMapKey(null, page.fullName ?? fallbackName ?? ""));
      this.repo.upsertTeacherMap({
        key,
        teacherId,
        name: page.fullName ?? fallbackName ?? `#${teacherId}`,
        vish: vishGroups.length > 0 || fromWebinars?.vish === true,
        groups: (vishGroups.length ? vishGroups : (fromWebinars?.groups ?? [])).slice(0, 40),
        subjects: [...subjects].slice(0, 40),
        department: page.info?.department ?? null,
        degree: page.info?.degree ?? null,
        photoUrl: page.info?.photoUrl ?? null,
        photoFileId: null,
        source: "portal",
        checkedAt: new Date().toISOString(),
      });
      return this.repo.teacherMapByKey(key);
    } catch (err) {
      // Отмечаем попытку, иначе «битый» id вечно первый в очереди обхода
      // (teacherMapStale сортирует непроверенных вперёд) и портал долбится зря.
      const key = teacherMapKey(teacherId, fallbackName ?? String(teacherId));
      const prev = this.repo.teacherMapByKey(key);
      this.repo.upsertTeacherMap({
        key,
        teacherId,
        name: prev?.name ?? fallbackName ?? `#${teacherId}`,
        vish: prev?.vish ?? false,
        groups: prev?.groups ?? [],
        subjects: prev?.subjects ?? [],
        department: prev?.department ?? null,
        degree: prev?.degree ?? null,
        photoUrl: prev?.photoUrl ?? null,
        photoFileId: prev?.photoFileId ?? null,
        source: "portal",
        checkedAt: new Date().toISOString(),
      });
      logger.debug({ err: String(err), teacherId }, "teacher map refresh failed");
      return null;
    }
  }

  /**
   * Поиск по своей карте преподавателей — без единого запроса к порталу.
   * Нужен inline-режиму: там запрос прилетает на каждую нажатую букву, и ходить
   * за каждую из них в портал нельзя.
   */
  searchLocal(query: string, limit = 5): Array<{ ref: TeacherRef; score: number; fuzzy: boolean; vish: boolean }> {
    const q = query.trim();
    if (q.length < 3) return [];
    return this.mapRows()
      .filter((r) => r.teacherId != null)
      .map((r) => ({ ref: { id: r.teacherId!, name: r.name }, vish: r.vish, ...nameMatch(r.name, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy) || Number(b.vish) - Number(a.vish) || b.score - a.score || a.ref.name.localeCompare(b.ref.name, "ru"))
      .slice(0, limit);
  }

  /** Карта целиком, с коротким кешем: в inline-режиме её читают очень часто. */
  private mapRows(): TeacherMapRow[] {
    if (!this.mapCache || Date.now() - this.mapCache.at > MAP_CACHE_TTL_MS) {
      this.mapCache = { at: Date.now(), rows: this.repo.teacherMapAll() };
    }
    return this.mapCache.rows;
  }

  /** Ведёт ли человек у ВИШ по карте: та самая пометка «(ВИШ)» рядом с фамилией. */
  isVish(teacherId: number | null, name?: string): boolean {
    const row = (teacherId != null ? this.repo.teacherMapById(teacherId) : null) ?? (name ? this.repo.teacherMapByKey(teacherMapKey(null, name)) : null);
    return row?.vish === true;
  }

  /**
   * Пометка «(ВИШ)» по уже загруженному расписанию преподавателя: его страница
   * называет группы каждой пары, и лишний запрос к порталу не нужен. Так карточка
   * человека, которого ночной обход ещё не дошёл проверить, помечается сразу.
   */
  noteFromLessons(teacherId: number, name: string, lessons: Occurrence[]): void {
    const groups = [...new Set(lessons.flatMap((o) => o.groups ?? []))];
    const vishGroups = groups.filter(isVishGroupTitle);
    // Пар ВИШ в этом окне нет — это не «не наш»: окно маленькое. Молчим.
    if (!vishGroups.length) return;
    const prev = this.repo.teacherMapById(teacherId);
    this.repo.upsertTeacherMap({
      key: prev?.key ?? teacherMapKey(teacherId, name),
      teacherId,
      name: prev?.name ?? name,
      vish: true,
      groups: [...new Set([...(prev?.groups ?? []), ...vishGroups])].slice(0, 40),
      subjects: prev?.subjects ?? [],
      department: prev?.department ?? null,
      degree: prev?.degree ?? null,
      photoUrl: prev?.photoUrl ?? null,
      photoFileId: prev?.photoFileId ?? null,
      source: "portal",
      checkedAt: prev?.checkedAt ?? new Date().toISOString(),
    });
  }

  /**
   * Проверить по порталу тех, кого прямо сейчас показываем человеку: ночной
   * обход идёт по всему ЧувГУ и до конкретной фамилии может дойти через неделю,
   * а пометка «(ВИШ)» нужна в списке сразу. Страница кешируется на 15 минут,
   * поэтому открытие карточки следом уже не стоит ни одного запроса.
   */
  async ensureMapped(refs: TeacherRef[], limit = 3): Promise<void> {
    const todo = refs.filter((r) => !this.repo.teacherMapById(r.id)?.checkedAt).slice(0, limit);
    for (const r of todo) {
      try {
        await this.refreshMapFor(r.id, r.name);
      } catch (err) {
        logger.debug({ err: String(err), teacher: r.id }, "ensureMapped failed");
      }
    }
  }

  /**
   * Порция фонового обхода: сначала заносим весь справочник в карту, потом
   * проверяем тех, кого ещё не смотрели (или смотрели давно).
   */
  async crawlMap(limit = 40): Promise<{ checked: number; vish: number }> {
    const dir = await this.directory();
    for (const t of dir) this.repo.seedTeacherMap(teacherMapKey(t.id, t.name), t.id, t.name);
    const ids = this.repo.teacherMapStale(limit);
    const nameById = new Map(dir.map((t) => [t.id, t.name]));
    let checked = 0;
    let vish = 0;
    for (const id of ids) {
      // Имя из справочника у нас уже есть: без него карточка без шапки
      // превратилась бы в «#12345».
      const row = await this.refreshMapFor(id, nameById.get(id));
      checked++;
      if (row?.vish) vish++;
    }
    if (checked) logger.info({ checked, vish, left: this.repo.teacherMapStats().total - this.repo.teacherMapStats().checked }, "teacher map crawl");
    return { checked, vish };
  }

  /** Забыть закешированный file_id: Telegram его не принял (сменили токен, файл удалён). */
  forgetPhotoFileId(key: string): void {
    this.repo.setTeacherPhotoFileId(key, "");
  }

  /** Фото преподавателя: из кеша Telegram (file_id) или байтами с портала. */
  async photo(teacherId: number): Promise<{ key: string; fileId: string | null; bytes: Buffer | null; row: TeacherMapRow | null }> {
    let row = this.repo.teacherMapById(teacherId);
    if (row?.photoFileId) return { key: row.key, fileId: row.photoFileId, bytes: null, row };
    // Пустая строка — это «забыли» из forgetPhotoFileId: качаем заново.
    if (!row?.photoUrl) {
      row = await this.refreshMapFor(teacherId, row?.name);
    }
    if (!row?.photoUrl) return { key: row?.key ?? teacherMapKey(teacherId, String(teacherId)), fileId: null, bytes: null, row: row ?? null };
    try {
      const bytes = await this.portal.getTeacherPhoto(row.photoUrl);
      return { key: row.key, fileId: null, bytes, row };
    } catch (err) {
      logger.debug({ err: String(err), teacherId }, "teacher photo failed");
      return { key: row.key, fileId: null, bytes: null, row };
    }
  }
}
