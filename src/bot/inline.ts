/**
 * Inline-режим: «@бот 12-23 завтра», «@бот неделя», «@бот поток 24 послезавтра»,
 * «@бот общие». Работает в любом чате, включая группы, и вставляет обычное
 * сообщение с расписанием — тем же текстом, что и в личке.
 *
 * Разбор запроса нарочно свободный: слова можно писать в любом порядке, дату —
 * словом («послепослезавтра») или числом («25.09»), группу — как угодно
 * («12-23», «виш 12 23»). Чего не хватает, берётся из настроек человека.
 */
import { createHash } from "node:crypto";
import type { InlineQueryResultArticle } from "grammy/types";
import type { Deps } from "./context.js";
import type { User } from "../db/repo.js";
import { dayView, weekView } from "./views.js";
import { findGroup, type LogicalGroup } from "../schedule/groups.js";
import { clampHtml, esc, filterSubgroup } from "../schedule/format.js";
import { loadProfile, personDayView, personWeekView, type PersonView } from "../people/profile.js";
import { hitShort, searchPeople, type PeopleScope, type PersonHit } from "../people/search.js";
import { refKey } from "../people/ref.js";
import { commonLessons, formatCommonLessons, formatStreamDay, mergeStream } from "../schedule/stream.js";
import type { Occurrence } from "../schedule/model.js";
import { ERSHOV_CARD, ERSHOV_SURNAME, isErshovQuery } from "./easter.js";
import { addDays, fmtDDMM, mondayOf, parseDayWord, parseRuDate, todayMsk, weekdayShort, type LocalDate } from "../time.js";

export type InlineMode = "auto" | "day" | "week" | "stream" | "common";

/**
 * Запрос про человека: «студент Беляев», «завтра преподаватель Петров» или
 * просто «Беляев завтра» (any — кто бы он ни был: преподаватель или студент).
 */
export interface InlinePerson {
  kind: "student" | "teacher" | "any";
  /** Фамилия (и имя), которые остались после служебных слов и даты. */
  query: string;
}

export interface InlineRequest {
  mode: InlineMode;
  date: LocalDate;
  /** Группы, которые человек назвал в запросе (пусто — возьмём его собственную). */
  groups: LogicalGroup[];
  /** Поток (год набора) из запроса, если назвали. */
  intake: number | null;
  /** Запрос вообще пустой: показываем короткую подсказку своей группой. */
  empty: boolean;
  /** В запросе была группа, но такой нет: об этом надо сказать, а не подсовывать свою. */
  unknownGroup: boolean;
  /** Спросили про человека, а не про группу. */
  person: InlinePerson | null;
}

const WEEK_WORDS = /^(нед|недел[а-яё]*|week)$/iu;
const NEXT_WORDS = /^(след|следующая|следующую|next)$/iu;
const STREAM_WORDS = /^(поток[а-яё]*|курс|stream)$/iu;
const COMMON_WORDS = /^(общ[а-яё]+|вместе|common)$/iu;
const DAY_WORDS = /^(пара|пары|день|дня)$/iu;

/** Подсказка в inline-списке: что вообще можно написать. */
export const INLINE_HINT = "12-23 завтра · неделя · поток 24 · общие · Беляев завтра · 25.09";
const STUDENT_WORDS = /^(студент[а-яё]*|студ|стд|student)$/iu;
const TEACHER_WORDS = /^(препод[а-яё]*|препа?|учител[а-яё]*|педагог[а-яё]*|teacher)$/iu;

/** Разбирает inline-запрос: режим, дату и группу. */
export function parseInlineQuery(deps: Deps, query: string, user: User | null): InlineRequest {
  const today = todayMsk();
  const words = query.trim().split(/\s+/).filter(Boolean);
  let mode: InlineMode = "auto";
  let date = today;
  let dateSet = false;
  let nextWeek = false;
  let person: InlinePerson["kind"] | null = null;
  const rest: string[] = [];
  for (const w of words) {
    if (STUDENT_WORDS.test(w)) {
      person = "student";
      continue;
    }
    if (TEACHER_WORDS.test(w)) {
      person = "teacher";
      continue;
    }
    if (WEEK_WORDS.test(w)) {
      mode = "week";
      continue;
    }
    if (NEXT_WORDS.test(w)) {
      nextWeek = true;
      continue;
    }
    if (STREAM_WORDS.test(w)) {
      mode = "stream";
      continue;
    }
    if (COMMON_WORDS.test(w)) {
      mode = "common";
      continue;
    }
    const offset = parseDayWord(w);
    if (offset !== null) {
      date = addDays(today, offset);
      dateSet = true;
      if (mode === "auto" && !DAY_WORDS.test(w)) mode = "day";
      continue;
    }
    const parsed = parseRuDate(w, today);
    if (parsed) {
      date = parsed;
      dateSet = true;
      continue;
    }
    rest.push(w);
  }
  if (nextWeek) {
    mode = "week";
    if (!dateSet) date = addDays(mondayOf(today), 7);
  }
  const groupQuery = rest.join(" ").trim();
  // «студент Беляев» — это не группа: фамилию нельзя отдавать поиску групп,
  // иначе человек получит «такой группы нет» вместо ответа.
  if (person) {
    return { mode, date, groups: [], intake: null, unknownGroup: false, empty: words.length === 0, person: { kind: person, query: groupQuery } };
  }
  const groups = groupQuery ? findGroup(deps.service.groups(), groupQuery) : [];
  // «Беляев завтра»: цифр нет, группой это не стало, а букв хватает на фамилию —
  // значит, спрашивают про человека, кто бы он ни был.
  if (groupQuery && !groups.length && !/\d/.test(groupQuery) && /\p{L}{3,}/u.test(groupQuery)) {
    return { mode, date, groups: [], intake: null, unknownGroup: false, empty: false, person: { kind: "any", query: groupQuery } };
  }
  // «поток 24» — это год набора, а не группа. Берём первое двузначное слово,
  // которое действительно есть среди наборов: в «поток 12 26» год — это «26».
  const intakes = deps.service.intakes();
  const named = rest.find((w) => /^\d{2}$/.test(w) && intakes.includes(Number(w)));
  // Года не назвали, но назвали группу («поток 12-26») — берём набор этой группы,
  // иначе человек попросил один поток, а получил бы свой.
  const fromGroup = groups[0]?.intake || null;
  const own = user?.groupKey ? deps.service.group(user.groupKey) : null;
  const effective = groups.length ? groups : own ? [own] : deps.service.groups().slice(0, 4);
  const wantsStream = mode === "stream" || mode === "common" || mode === "auto";
  return {
    mode,
    date,
    groups: effective,
    intake: named ? Number(named) : wantsStream ? (fromGroup ?? own?.intake ?? intakes[0] ?? null) : null,
    // Запрос был, но группу по нему не нашли: подставлять свою молча нельзя.
    unknownGroup: !!groupQuery && groups.length === 0,
    empty: words.length === 0,
    person: null,
  };
}

// Резать HTML посередине тега нельзя: Telegram отвергает весь ответ целиком,
// а не одну карточку. clampHtml обрезает по строкам и закрывает теги.
const cut = (s: string, n = 4000): string => clampHtml(s, n);

/** Короткое описание для строки результата (Telegram показывает две строки). */
function preview(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .slice(2)
    .filter((l) => l.trim())
    .join(" · ")
    .slice(0, 110);
}

/**
 * id inline-результата ограничен 64 байтами, а кириллица занимает по два.
 * Режем по байтам и выбрасываем «обрубок» последней буквы: из него получается
 * U+FFFD, который сам по себе занимает три байта и снова ломает лимит.
 */
function shortId(id: string): string {
  const buf = Buffer.from(id, "utf8");
  if (buf.length <= 64) return id;
  const cut = buf.subarray(0, 64).toString("utf8").replace(/\uFFFD+$/, "");
  return Buffer.byteLength(cut) <= 64 ? cut : cut.slice(0, -1);
}

function article(id: string, title: string, text: string): InlineQueryResultArticle {
  return {
    type: "article",
    id: shortId(id),
    title,
    description: preview(text),
    input_message_content: { message_text: cut(text), parse_mode: "HTML" },
  };
}

function streamRows(deps: Deps, intake: number, from: LocalDate, to: LocalDate, own: LogicalGroup | null, subgroup: number | null) {
  const groups = deps.service.stream(intake);
  const byGroup = new Map<string, Occurrence[]>();
  for (const g of groups) {
    const list = deps.service.materialize(g, from, to);
    byGroup.set(g.key, own && g.key === own.key ? filterSubgroup(list, subgroup) : list);
  }
  return { groups, rows: mergeStream(groups, byGroup) };
}

/** Готовые варианты для Telegram: день, неделя, поток, общие пары. */
export function buildInlineResults(deps: Deps, req: InlineRequest, user: User | null): InlineQueryResultArticle[] {
  const today = todayMsk();
  const own = user?.groupKey ? deps.service.group(user.groupKey) : null;
  const subgroup = user?.subgroup ?? null;
  const view = user?.teacherView ?? "bold";
  const out: InlineQueryResultArticle[] = [];
  const dayTitle = (g: LogicalGroup, date: LocalDate): string => `${g.title} · ${date === today ? "сегодня" : date === addDays(today, 1) ? "завтра" : `${weekdayShort(date)} ${fmtDDMM(date)}`}`;

  const addDay = (g: LogicalGroup): void => {
    const { text } = dayView(deps, g, req.date, own && g.key === own.key ? subgroup : null, view);
    out.push(article(`d:${g.key}:${req.date}`, `📅 ${dayTitle(g, req.date)}`, text));
  };
  const addWeek = (g: LogicalGroup): void => {
    const { text, monday } = weekView(deps, g, req.date, own && g.key === own.key ? subgroup : null, view);
    out.push(article(`w:${g.key}:${monday}`, `🗓 ${g.title} · неделя ${fmtDDMM(monday)}–${fmtDDMM(addDays(monday, 6))}`, text));
  };
  // Поток за день и общие пары за неделю читают одни и те же группы, а день
  // всегда внутри своей недели. Материализуем неделю один раз: inline-запрос
  // прилетает на каждое нажатие клавиши, и лишний разбор расписания там дорог.
  const weekCache = new Map<string, ReturnType<typeof streamRows>>();
  const streamWeek = (intake: number, monday: LocalDate): ReturnType<typeof streamRows> => {
    const key = `${intake}:${monday}`;
    let cached = weekCache.get(key);
    if (!cached) {
      cached = streamRows(deps, intake, monday, addDays(monday, 6), own, subgroup);
      weekCache.set(key, cached);
    }
    return cached;
  };
  const addStream = (intake: number): void => {
    const { rows } = streamWeek(intake, mondayOf(req.date));
    const text = formatStreamDay(intake, req.date, rows, deps.service.weekInfo(req.date), today, own?.intake === intake ? own.key : null, view);
    out.push(article(`s:${intake}:${req.date}`, `🎓 Поток 20${intake} · ${req.date === today ? "сегодня" : fmtDDMM(req.date)}`, text));
  };
  const addCommon = (intake: number): void => {
    const monday = mondayOf(req.date);
    const { rows } = streamWeek(intake, monday);
    const ownInStream = own && own.intake === intake ? own : null;
    const text = formatCommonLessons(intake, monday, rows, ownInStream, view);
    if (!commonLessons(rows, ownInStream?.key ?? null).length && !ownInStream) return;
    out.push(article(`c:${intake}:${monday}`, `🤝 Общие пары · поток 20${intake}`, text));
  };

  if (req.unknownGroup) {
    out.push(
      article(
        `nf:${req.date}`,
        "🤷 Такой группы не нашёл",
        "Проверь номер: группы ВИШ выглядят как 12-23. Можно написать просто «12-23», «виш 12 23» или добавить дату: «12-23 завтра».",
      ),
    );
  }
  switch (req.mode) {
    case "week":
      for (const g of req.groups.slice(0, 8)) addWeek(g);
      break;
    case "stream":
      if (req.intake != null) addStream(req.intake);
      for (const g of req.groups.slice(0, 4)) addDay(g);
      break;
    case "common":
      if (req.intake != null) addCommon(req.intake);
      break;
    case "day":
      for (const g of req.groups.slice(0, 8)) addDay(g);
      break;
    default: {
      // Без явного режима показываем всё сразу по первой группе, потом дни остальных.
      const [first, ...others] = req.groups;
      if (first) {
        addDay(first);
        addWeek(first);
        if (first.intake) {
          addStream(first.intake);
          addCommon(first.intake);
        }
      }
      for (const g of others.slice(0, 6)) addDay(g);
    }
  }
  // Пустой запрос — человек ещё не знает, что писать: подсказка последней
  // карточкой, а полный гайд открывает кнопка «❔ Как писать запрос» сверху.
  if (req.empty) out.push(article("hint", "❔ Что ещё можно написать", `Примеры запросов: ${INLINE_HINT}`));
  return out.slice(0, 20);
}


// ---- inline про людей: «Беляев завтра», «студент Беляев», «неделя препод Петров» ----

/** Короче этого запрос про студента людей не показывает. */
export const MIN_STUDENT_QUERY = 4;

const person3 = (q: string): string => createHash("sha1").update(q.toLowerCase()).digest("base64url").slice(0, 8);

/**
 * Результаты по человеку — та же карточка, что в личке (кто это, где сейчас по
 * расписанию, день или неделя), и тот же поиск с его правилами: опечатка —
 * «возможно, это», студенты — только с POISK, от 4 букв, в журнале и в лимите.
 * Портал inline не трогает: запрос прилетает на каждую букву, поэтому
 * преподаватели ищутся по своей карте, а расписание тянется только у первого.
 */
export async function buildPeopleResults(deps: Deps, req: InlineRequest, user: User | null, opts: { isAdmin?: boolean } = {}): Promise<InlineQueryResultArticle[]> {
  if (!req.person || req.person.kind === "student" || !isErshovQuery(req.person.query)) return peopleResults(deps, req, user, opts);
  // Пасхалка — первой карточкой, следом настоящие однофамильцы (по фамилии,
  // а не по всему запросу: иначе «Кирилл Ершов» дал бы любого Кирилла).
  const namesakes = await peopleResults(deps, { ...req, person: { ...req.person, query: ERSHOV_SURNAME } }, user, opts);
  return [article("p:ershov", "🏅 Кирилл Ершов — спорторг ВИШ", ERSHOV_CARD), ...namesakes.filter((r) => !r.id.startsWith("p:nf:"))];
}

async function peopleResults(deps: Deps, req: InlineRequest, user: User | null, opts: { isAdmin?: boolean }): Promise<InlineQueryResultArticle[]> {
  const person = req.person;
  if (!person) return [];
  const q = person.query.trim();
  const today = todayMsk();
  if (q.length < 3) {
    const hint = {
      student: ["🕵️ Напиши фамилию студента", "Например: <code>студент Беляев</code>. Бот найдёт группу человека и покажет, где он должен быть по расписанию."],
      teacher: ["👨‍🏫 Напиши фамилию преподавателя", "Например: <code>преподаватель Петров</code> или <code>завтра препод Петров</code>, <code>неделя препод Петров</code>."],
      any: ["👤 Напиши фамилию", "Например: <code>Беляев завтра</code> — покажу расписание человека, будь то преподаватель или студент."],
    }[person.kind];
    return [article(`p:hint:${person.kind}`, hint[0]!, hint[1]!)];
  }
  const scope: PeopleScope = person.kind === "any" ? "all" : person.kind;
  if (scope === "student" && !(deps.config.POISK && deps.students?.ready())) {
    return [article("p:off", "🕵️ Поиск людей выключен", "В этом боте поиск студентов не включён. Расписание групп работает: попробуй <code>12-23 завтра</code>.")];
  }
  const res = await searchPeople(deps, q, { scope, viewerId: user?.id ?? 0, isAdmin: opts.isAdmin === true, source: "inline", localOnly: true, minStudentQuery: MIN_STUDENT_QUERY, limit: 5 });
  if (scope === "student" && res.students === "limit") return [article("p:limit", "🕵️ Лимит на сегодня исчерпан", `Поиск людей ограничен: ${deps.config.POISK_DAILY_LIMIT} в день. Завтра снова можно.`)];
  // По трём буквам людей не показываем вовсе: такой запрос не записывался бы
  // в журнал и не тратил лимит, и реестр можно было бы перебрать по слогам.
  if (scope === "student" && res.students === "short") return [article(`p:short:${person3(q)}`, "🕵️ Допиши фамилию", `Напиши хотя бы ${MIN_STUDENT_QUERY} буквы фамилии — тогда покажу, кто это и где он по расписанию.`)];
  if (!res.hits.length) {
    const notes: string[] = [];
    if (!deps.teachers && scope !== "student") notes.push("Преподавателей без учётки портала бот знает только по онлайн-парам ВИШ.");
    if (scope === "all" && res.students === "short") notes.push(`Студентов ищу от ${MIN_STUDENT_QUERY} букв фамилии.`);
    if (scope === "all" && res.students === "limit") notes.push("Студентов сегодня больше не ищу: дневной лимит исчерпан.");
    if (deps.teachers && scope !== "student") notes.push("Преподавателя можно поискать и в самом боте: там он спросит портал.");
    return [article(`p:nf:${person3(q)}`, "🤷 Никого не нашёл", `По «${esc(q)}» никого нет.${notes.length ? ` ${notes.join(" ")}` : ""}`)];
  }
  return peopleArticles(deps, req, user, res.hits, q, today);
}

/** Одна карточка на найденного; у преподавателей портала — только у первого. */
async function peopleArticles(deps: Deps, req: InlineRequest, user: User | null, hits: PersonHit[], q: string, today: LocalDate): Promise<InlineQueryResultArticle[]> {
  const out: InlineQueryResultArticle[] = [];
  const viewer = { teacherView: user?.teacherView ?? ("bold" as const) };
  const others: PersonHit[] = [];
  let portalShown = false;
  for (const hit of hits) {
    // Портальное расписание тянем у одного человека: каждая буква запроса не
    // должна превращаться в поход на портал. Остальные — строкой «похожи ещё».
    if (hit.ref.kind === "teacher" && portalShown) {
      others.push(hit);
      continue;
    }
    const profile = await loadProfile(deps, hit.ref, user?.id ?? null);
    if (!profile) continue;
    if (hit.ref.kind === "teacher") portalShown = true;
    // Совпало только с опечаткой — так и говорим: «Салодилин» не должен молча
    // открыть расписание Солодилина, как будто это точный ответ.
    const guess = hit.fuzzy ? "Возможно, это " : "";
    const icon = profile.role === "teacher" ? "👨‍🏫" : "🎓";
    const who = profile.role === "teacher" ? `${profile.name}${profile.vish ? " (ВИШ)" : ""}` : `${profile.name} · ${profile.group?.title ?? profile.student?.groupTitle ?? ""}`;
    const key = refKey(profile.ref);
    const loading = hit.ref.kind === "teacher" ? 6000 : 0;
    if (req.mode === "week") {
      const view = loading ? await withTimeout(personWeekView(deps, profile, req.date, viewer), loading) : await personWeekView(deps, profile, req.date, viewer);
      if (!view) out.push(article(`pl:${key}`, `${icon} ${who} · расписание грузится`, `Портал отвечает медленно. Набери запрос ещё раз через пару секунд — расписание ${esc(profile.name)} уже будет готово.`));
      else out.push(article(`pw:${key}:${view.monday}`, `${icon} ${guess}${who} · неделя ${fmtDDMM(view.monday)}`, inlineText(view)));
      continue;
    }
    const view = loading ? await withTimeout(personDayView(deps, profile, req.date, viewer), loading) : await personDayView(deps, profile, req.date, viewer);
    if (!view) {
      out.push(article(`pl:${key}`, `${icon} ${who} · расписание грузится`, `Портал отвечает медленно. Набери запрос ещё раз через пару секунд — расписание ${esc(profile.name)} уже будет готово.`));
      continue;
    }
    const when = req.date === today ? "сегодня" : `${weekdayShort(req.date)} ${fmtDDMM(req.date)}`;
    out.push(article(`pd:${key}:${req.date}`, `${icon} ${guess}${who} · ${when}`.slice(0, 120), inlineText(view)));
  }
  if (others.length) {
    const names = others.map(hitShort);
    out.push(article(`p:more:${person3(q)}`, `👥 Похожие: ${names.join(", ")}`.slice(0, 60), `По «${esc(q)}» похожи ещё: ${esc(names.join("; "))}. Напиши фамилию точнее — покажу расписание нужного.`));
  }
  return out;
}

/** В inline кнопок нет: выбор группы для студента — только в личке. */
function inlineText(view: PersonView): string {
  return view.needsGroup ? view.text.replace(/ — выбери:$/, ". Выбрать группу можно в личке с ботом.") : view.text;
}

/** Ждём портал ограниченное время: inline-ответ Telegram ждать долго не станет. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
