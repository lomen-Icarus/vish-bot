/**
 * Карточка человека — одна на всех. Кого бы ни нашли (преподавателя по кнопке,
 * студента в «сыске», кого угодно через ИИ-поиск или inline), человек
 * выглядит одинаково:
 *
 *   👨‍🏫 / 🎓 ФИО (ВИШ)
 *   кто это: преподаватель ВИШ · кафедра · степень / студент ВИШ · группа
 *   📍 где он сейчас по расписанию
 *   день или неделя расписания
 *
 * Здесь только данные и текст; кнопки и отправка — в src/bot/people.ts.
 */
import type { Deps } from "../bot/context.js";
import type { User, WebinarRow } from "../db/repo.js";
import type { TeacherRef } from "../portal/teachers.js";
import { teacherMapKey } from "../portal/teachers.js";
import type { WebinarTeacher } from "../portal/webinars.js";
import type { StudentRecord } from "../students/directory.js";
import { resolveStudentGroup, whereNowText } from "../students/locate.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { personGroup } from "../schedule/groups.js";
import type { Occurrence } from "../schedule/model.js";
import { clampHtml, esc, filterSubgroup, formatDay, formatWeek } from "../schedule/format.js";
import { groupLessons } from "../bot/views.js";
import { samePerson, normName } from "../text/match.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../time.js";
import { logger } from "../logger.js";
import { refKey, roleOf, webinarNameKey, type PersonRef, type PersonRole } from "./ref.js";

export interface PersonProfile {
  ref: PersonRef;
  role: PersonRole;
  /** Полное ФИО, если оно известно, иначе как записано в справочнике. */
  name: string;
  /** Ведёт у ВИШ (для преподавателя) — пометка «(ВИШ)» рядом с фамилией. */
  vish: boolean;
  /** Кто это, одной строкой: «Преподаватель ВИШ · кафедра · к.т.н.», «Студент ВИШ · ВИШ-12-23 · 1 подгруппа». */
  subtitle: string;
  /** Оговорка о полноте данных, например «видны только онлайн-пары». */
  note: string | null;
  teacher?: TeacherRef;
  webinar?: WebinarTeacher;
  student?: StudentRecord;
  /** Группа студента в расписании; null — не нашлась или их несколько. */
  group?: LogicalGroup | null;
  ambiguous?: LogicalGroup[];
}

/**
 * Какую из одноимённых групп человек выбрал для студента (ВИШ-11-23 бывает
 * ЭиЭА и РЗиАЭС, а реестр пишет просто «ВИШ-11-23»). Живёт в памяти: выбор
 * нужен, пока человек листает карточку, а в callback_data ключ группы не влезет.
 */
const groupChoice = new Map<string, string>();

export function chooseStudentGroup(viewerId: number, studentId: string, groupKey: string): void {
  groupChoice.set(`${viewerId}:${studentId}`, groupKey);
  if (groupChoice.size > 5000) groupChoice.delete(groupChoice.keys().next().value!);
}

/** Студенты видны только при включённом «сыске». */
export function studentsEnabled(deps: Deps): boolean {
  return !!deps.config.POISK && !!deps.students;
}

function teacherVish(deps: Deps, teacherId: number | null, name: string): boolean {
  const row = (teacherId != null ? deps.repo.teacherMapById(teacherId) : null) ?? deps.repo.teacherMapByKey(teacherMapKey(null, name));
  return row?.vish === true;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((x): x is string => !!x && !!x.trim()).join(" · ");
}

/** Карточка портального преподавателя. */
async function teacherProfile(deps: Deps, id: number): Promise<PersonProfile | null> {
  if (!deps.teachers) return null;
  const t = await deps.teachers.byId(id);
  if (!t) return null;
  const row = deps.repo.teacherMapById(id);
  // В карте имя обычно полное (со страницы преподавателя), в справочнике — «Фамилия И.О.».
  const name = row?.name && row.name.length > t.name.length && samePerson(row.name, t.name) ? row.name : t.name;
  const vish = teacherVish(deps, id, name);
  return {
    ref: { kind: "teacher", id },
    role: "teacher",
    name,
    vish,
    subtitle: joinParts([vish ? "Преподаватель ВИШ" : "Преподаватель", row?.department, row?.degree]),
    note: null,
    teacher: t,
  };
}

/** Преподаватель со страницы вебинаров; если он есть в справочнике — карточка портального. */
async function webinarProfile(deps: Deps, key: string): Promise<PersonProfile | null> {
  const w = (deps.webinars?.teachers() ?? []).find((t) => webinarNameKey(t.name) === key);
  if (!w) return null;
  if (deps.teachers) {
    try {
      // Тот же человек в справочнике — значит, у него есть и очные пары: показываем полную карточку.
      const found = (await deps.teachers.searchScored(w.name, 5)).filter((x) => !x.fuzzy && samePerson(x.ref.name, w.name));
      if (found.length === 1) {
        const full = await teacherProfile(deps, found[0]!.ref.id);
        if (full) return full;
      }
    } catch (err) {
      logger.debug({ err: String(err) }, "people: webinar teacher lookup in the directory failed");
    }
  }
  return {
    ref: { kind: "webinar", key },
    role: "teacher",
    name: w.name,
    // Страница вебинаров — факультет ВИШ: все, кто там ведёт, — наши.
    vish: true,
    subtitle: joinParts(["Преподаватель ВИШ", w.position, w.degree]),
    note: deps.teachers ? "В справочнике портала не нашёлся — видны только онлайн-пары." : "Видны только онлайн-пары: очные пары портал показывает лишь с учёткой.",
    webinar: w,
  };
}

function studentProfile(deps: Deps, id: string, viewerId: number | null): PersonProfile | null {
  if (!studentsEnabled(deps)) return null;
  const st = deps.students!.get(id);
  if (!st) return null;
  const chosen = viewerId != null ? groupChoice.get(`${viewerId}:${id}`) : undefined;
  const pinned = chosen ? deps.service.group(chosen) : null;
  const { group, ambiguous } = pinned ? { group: pinned, ambiguous: [] as LogicalGroup[] } : resolveStudentGroup(deps.service.groups(), st);
  return {
    ref: { kind: "student", id },
    role: "student",
    name: st.name,
    vish: true,
    subtitle: joinParts(["Студент ВИШ", group?.title ?? st.groupTitle, st.subgroup ? `${st.subgroup} подгруппа` : null]),
    note: null,
    student: st,
    group,
    ambiguous,
  };
}

/** Профиль по ссылке. null — человека больше нет (реестр обновился, справочник без учётки и т. п.). */
export async function loadProfile(deps: Deps, ref: PersonRef, viewerId: number | null = null): Promise<PersonProfile | null> {
  if (ref.kind === "teacher") return teacherProfile(deps, ref.id);
  if (ref.kind === "webinar") return webinarProfile(deps, ref.key);
  return studentProfile(deps, ref.id, viewerId);
}

/** Пары со страницы вебинаров как обычные пары расписания: онлайн, с группами и темой. */
function webinarLessons(deps: Deps, w: WebinarTeacher, from: LocalDate, to: LocalDate): Occurrence[] {
  return webinarRowsToLessons(deps.repo.webinarsBetween(from, to), w.name);
}

/** Строки страницы вебинаров одного преподавателя → пары расписания. */
export function webinarRowsToLessons(rows: WebinarRow[], teacherName: string): Occurrence[] {
  const name = normName(teacherName);
  return rows
    .filter((r) => r.scheduled && normName(r.teacher) === name)
    .map((r) => ({
      groupKey: `webinar:${webinarNameKey(teacherName)}`,
      period: 1 as const,
      date: r.date,
      slot: r.slot,
      start: r.start,
      end: r.end,
      subject: r.subject,
      type: r.type.replace(/\.$/, "").toLowerCase(),
      room: null,
      teacher: null,
      subgroup: r.subgroup,
      isDistance: true,
      status: "scheduled" as const,
      sources: [],
      groups: r.groups,
      topic: r.title ?? undefined,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
}

export interface LoadedLessons {
  lessons: Occurrence[];
  /** Полное ФИО со страницы преподавателя, если портал его назвал. */
  fullName: string | null;
  /** Портал не ответил: это не «пар нет», так и надо сказать. */
  failed: boolean;
}

/** Пары человека за [from, to]. */
export async function profileLessons(deps: Deps, p: PersonProfile, from: LocalDate, to: LocalDate): Promise<LoadedLessons> {
  if (p.teacher && deps.teachers) {
    try {
      const { lessons, fullName } = await deps.teachers.lessons(p.teacher, from, to);
      // Страница называет группы каждой пары: пометка «(ВИШ)» ставится сразу.
      deps.teachers.noteFromLessons(p.teacher.id, fullName ?? p.name, lessons);
      return { lessons, fullName, failed: false };
    } catch (err) {
      logger.warn({ err: String(err), teacher: p.teacher.id }, "people: teacher schedule failed");
      return { lessons: [], fullName: null, failed: true };
    }
  }
  if (p.webinar) return { lessons: webinarLessons(deps, p.webinar, from, to), fullName: null, failed: false };
  if (p.group) return { lessons: filterSubgroup(groupLessons(deps, p.group, from, to), p.student?.subgroup ?? null), fullName: null, failed: false };
  return { lessons: [], fullName: null, failed: false };
}

/** Шапка карточки: иконка, ФИО, пометка (ВИШ), кто это. */
export function personHead(p: PersonProfile, fullName?: string | null): string {
  const icon = p.role === "teacher" ? "👨‍🏫" : "🎓";
  const name = fullName && fullName.length >= p.name.length ? fullName : p.name;
  const tag = p.role === "teacher" && p.vish ? " (ВИШ)" : "";
  return `${icon} <b>${esc(name)}</b>${tag}\n<i>${esc(p.subtitle)}</i>${p.note ? `\n<i>${esc(p.note)}</i>` : ""}`;
}

/** Почему у студента нет расписания: группа не нашлась или их под одним номером несколько. */
export function noGroupText(p: PersonProfile): string {
  if (p.ambiguous?.length) return `В расписании под «${esc(p.student?.groupTitle ?? "")}» несколько разных групп. В реестре не написано, какая именно — выбери:`;
  return /^ОЗ/i.test(p.student?.groupTitle ?? "") ? "Это заочная группа: её расписание бот не показывает." : "Такой группы нет в расписании ВИШ (возможно, человек уже выпустился или перевёлся).";
}

/** Пары по датам, одним проходом. */
export function groupByDate(lessons: Occurrence[]): Map<LocalDate, Occurrence[]> {
  const byDate = new Map<LocalDate, Occurrence[]>();
  for (const o of lessons) {
    const list = byDate.get(o.date);
    if (list) list.push(o);
    else byDate.set(o.date, [o]);
  }
  return byDate;
}

export interface PersonView {
  text: string;
  /** Короткая подпись к постеру: кто это и (для дня) где он сейчас. */
  caption: string;
  /** Неделя: пары по датам (уже разложены — постеру не нужно делать это снова). */
  byDate?: Map<LocalDate, Occurrence[]>;
  lessons: Occurrence[];
  /** Портал не ответил. */
  failed: boolean;
  /** Студент без понятной группы: вместо расписания нужен выбор группы. */
  needsGroup: boolean;
}

/** Карточка на день: шапка, где сейчас по расписанию, пары дня. */
export async function personDayView(deps: Deps, p: PersonProfile, date: LocalDate, viewer: Pick<User, "teacherView">): Promise<PersonView> {
  if (p.role === "student" && !p.group) {
    const text = `${personHead(p)}\n\n${noGroupText(p)}`;
    return { text, caption: text, lessons: [], failed: false, needsGroup: !!p.ambiguous?.length };
  }
  const loaded = await profileLessons(deps, p, date, date);
  const head = personHead(p, loaded.fullName);
  if (loaded.failed) {
    const text = `${head}\n\nНе удалось загрузить расписание: портал не ответил. Попробуй позже.`;
    return { text, caption: text, lessons: [], failed: true, needsGroup: false };
  }
  const today = todayMsk();
  const where = whereNowText(loaded.lessons, date, today, p.student?.subgroup ?? null, { teacher: p.role === "teacher" });
  // У преподавателя в его же расписании фамилия не нужна — это он сам.
  const day = formatDay(personGroup(p.name, refKey(p.ref)), date, loaded.lessons, deps.service.weekInfo(date), today, { now: wallClock(), teacherView: p.role === "teacher" ? "off" : viewer.teacherView, hideTitle: true });
  return { text: clampHtml(`${head}\n\n${where}\n\n${day}`), caption: `${head}\n\n${where}`, lessons: loaded.lessons, failed: false, needsGroup: false };
}

/** Карточка на неделю: шапка и неделя пар. */
export async function personWeekView(deps: Deps, p: PersonProfile, anyDate: LocalDate, viewer: Pick<User, "teacherView">): Promise<PersonView & { monday: LocalDate }> {
  const monday = mondayOf(anyDate);
  if (p.role === "student" && !p.group) {
    const text = `${personHead(p)}\n\n${noGroupText(p)}`;
    return { text, caption: text, lessons: [], failed: false, needsGroup: !!p.ambiguous?.length, monday };
  }
  const loaded = await profileLessons(deps, p, monday, addDays(monday, 6));
  const head = personHead(p, loaded.fullName);
  if (loaded.failed) {
    const text = `${head}\n\nНе удалось загрузить расписание: портал не ответил. Попробуй позже.`;
    return { text, caption: text, lessons: [], failed: true, needsGroup: false, monday };
  }
  const byDate = groupByDate(loaded.lessons);
  const week = formatWeek(personGroup(p.name, refKey(p.ref)), monday, byDate, deps.service.weekInfo(monday), todayMsk(), { teacherView: p.role === "teacher" ? "off" : viewer.teacherView, hideTitle: true });
  return { text: clampHtml(`${head}\n\n${week}`), caption: head, lessons: loaded.lessons, byDate, failed: false, needsGroup: false, monday };
}

/**
 * Где человек сейчас — простым текстом, для ИИ. Та же строка, что в карточке,
 * только без разметки: модель и кнопка говорят об одном и том же.
 */
export function whereNowPlain(lessons: Occurrence[], role: PersonRole, subgroup: number | null): string {
  const today = todayMsk();
  return whereNowText(lessons.filter((o) => o.date === today), today, today, subgroup, { teacher: role === "teacher" }).replace(/<[^>]+>/g, "");
}

export { roleOf, refKey };
