/**
 * Один поиск людей на весь бот. Кнопка «👨‍🏫 Преподаватели», «Где студент»,
 * «🔍 ИИ поисковик», ИИ и inline ищут здесь и получают один и тот же список с одними
 * и теми же правилами:
 *
 *  • фамилия с опечаткой — только «может быть, кто-то из них», никогда не
 *    открывает чужое расписание молча;
 *  • студенты — только при POISK=TRUE, каждый поиск в журнале и в лимите;
 *  • преподаватель со страницы вебинаров, который есть и в справочнике
 *    портала, показывается один раз.
 */
import type { Deps } from "../bot/context.js";
import { shortName, samePerson } from "../text/match.js";
import { todayMsk } from "../time.js";
import { teacherMapByName } from "../portal/teachers.js";
import { studentsEnabled } from "./profile.js";
import { shortGroupTitle } from "../schedule/groups.js";
import { webinarNameKey, type PersonRef, type PersonRole } from "./ref.js";

export type PeopleScope = "teacher" | "student" | "all";

export interface PersonHit {
  ref: PersonRef;
  role: PersonRole;
  name: string;
  fuzzy: boolean;
  score: number;
  /** Преподаватель ВИШ (пометка «(ВИШ)»); у студентов всегда true. */
  vish: boolean;
  /** Студент: группа, как записана в реестре. */
  groupTitle?: string;
  /** Преподаватель известен только по странице вебинаров. */
  webinarOnly?: boolean;
}

/** Что со студентами в этом поиске: искали, выключено, лимит, слишком короткий запрос. */
export type StudentSearchState = "ok" | "off" | "limit" | "short" | "skipped";

export interface PeopleSearchResult {
  hits: PersonHit[];
  students: StudentSearchState;
}

export interface PeopleSearchOptions {
  scope: PeopleScope;
  viewerId: number;
  isAdmin: boolean;
  /** Откуда поиск: так он и записывается в журнал «сыска». */
  source: "поиск" | "ии" | "inline";
  /** Только своя база, без походов на портал (inline: запрос на каждую букву). */
  localOnly?: boolean;
  /** Короче этого студентов не ищем (inline — 4 буквы, иначе реестр перебирается по слогам). */
  minStudentQuery?: number;
  limit?: number;
}

function teacherVish(deps: Deps, teacherId: number | null, name: string): boolean {
  const row = (teacherId != null ? deps.repo.teacherMapById(teacherId) : null) ?? teacherMapByName(deps.repo, name);
  return row?.vish === true;
}

/** Можно ли этому человеку сейчас искать студентов (дневной лимит; админы без лимита). */
export function studentSearchAllowed(deps: Deps, viewerId: number, isAdmin: boolean): boolean {
  const limit = deps.config.POISK_DAILY_LIMIT;
  return limit <= 0 || isAdmin || deps.repo.poiskUsage(viewerId, todayMsk()) < limit;
}

export async function searchPeople(deps: Deps, query: string, opts: PeopleSearchOptions): Promise<PeopleSearchResult> {
  const q = query.trim();
  const hits: PersonHit[] = [];
  let students: StudentSearchState = "skipped";
  if (q.length < 2) return { hits, students };

  if (opts.scope !== "student") {
    if (deps.teachers) {
      const scored = opts.localOnly ? deps.teachers.searchLocal(q, 5) : await deps.teachers.searchScored(q, 6).catch(() => []);
      // Пометку «(ВИШ)» ставит карта, а ночной обход до этой фамилии мог ещё не дойти.
      if (!opts.localOnly) await deps.teachers.ensureMapped(scored.map((x) => x.ref)).catch(() => undefined);
      for (const x of scored) hits.push({ ref: { kind: "teacher", id: x.ref.id }, role: "teacher", name: x.ref.name, fuzzy: x.fuzzy, score: x.score, vish: teacherVish(deps, x.ref.id, x.ref.name) });
    }
    for (const w of deps.webinars?.searchScored(q, 5) ?? []) {
      if (hits.some((h) => h.role === "teacher" && samePerson(h.name, w.teacher.name))) continue;
      hits.push({ ref: { kind: "webinar", key: webinarNameKey(w.teacher.name) }, role: "teacher", name: w.teacher.name, fuzzy: w.fuzzy, score: w.score, vish: true, webinarOnly: true });
    }
  }

  if (opts.scope !== "teacher") {
    const dir = deps.students;
    if (!studentsEnabled(deps) || !dir?.ready()) students = "off";
    else if (q.length < (opts.minStudentQuery ?? 3)) students = "short";
    else if (!studentSearchAllowed(deps, opts.viewerId, opts.isAdmin)) students = "limit";
    else {
      students = "ok";
      const found = dir.search(q, 8);
      const first = found.find((h) => !h.fuzzy) ?? null;
      // Журнал ведём всегда, в том числе на промахах: иначе реестр можно было бы
      // перебирать по фамилиям бесплатно и без следов. Inline пишет найденного, а
      // не набранные буквы: «Беля» и «Беляев» с одним и тем же человеком — один поиск.
      const logged = opts.source === "inline" ? `поиск: ${found[0]?.student.name ?? q}` : `${opts.source}: ${q}`;
      deps.repo.logPoisk(opts.viewerId, todayMsk(), logged, first?.student.id ?? null);
      for (const h of found) hits.push({ ref: { kind: "student", id: h.student.id }, role: "student", name: h.student.name, fuzzy: h.fuzzy, score: h.score, vish: true, groupTitle: h.student.groupTitle });
    }
  }

  // При равных очках «наш» (ВИШ) впереди однофамильцев из других институтов.
  hits.sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy) || b.score - a.score || Number(b.vish) - Number(a.vish) || a.name.localeCompare(b.name, "ru"));
  return { hits: hits.slice(0, opts.limit ?? 8), students };
}

/**
 * Один ли это ответ: точное совпадение одно, или первое заметно впереди
 * остальных (у кого-то совпало только отчество). Иначе — список кандидатов.
 */
export function clearHit(hits: PersonHit[]): PersonHit | null {
  const exact = hits.filter((h) => !h.fuzzy);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1 && exact[0]!.score - exact[1]!.score >= 3) return exact[0]!;
  // Одинаково подходят несколько преподавателей, но из ВИШ среди них ровно один
  // и студентов с таким именем нет — это он: бот для ВИШ. Остальных покажет
  // «🔎 Найти другого» под карточкой.
  const top = exact.filter((h) => h.score === exact[0]?.score);
  const vishTeachers = top.filter((h) => h.role === "teacher" && h.vish);
  if (top.length > 1 && vishTeachers.length === 1 && top.every((h) => h.role === "teacher")) return vishTeachers[0]!;
  return null;
}

/** Кто подходил так же точно, как выбранный: их показывают кнопками под карточкой. */
export function tiedWith(hits: PersonHit[], chosen: PersonHit): PersonHit[] {
  return hits.filter((h) => h !== chosen && !h.fuzzy && h.score === chosen.score);
}

/** «ВИШ-12-23» → «12-23»: короче в кнопке. */
function shortGroup(title: string | undefined): string {
  return shortGroupTitle(title ?? "");
}

/** Подпись кнопки с человеком — одна и та же в любом разделе бота. */
export function hitLabel(h: Pick<PersonHit, "role" | "name" | "vish" | "webinarOnly" | "groupTitle">): string {
  if (h.role === "teacher") return `👨‍🏫 ${h.name}${h.vish ? (h.webinarOnly ? " (ВИШ, дистант)" : " (ВИШ)") : ""}`.slice(0, 60);
  return `🎓 ${h.name} · ${shortGroup(h.groupTitle)}`.slice(0, 60);
}

/** Короткое имя для строк вроде «Похожи: …». */
export function hitShort(h: PersonHit): string {
  return h.role === "teacher" ? `${shortName(h.name)}${h.vish ? " (ВИШ)" : ""}` : `${h.name} (${shortGroup(h.groupTitle)})`;
}
