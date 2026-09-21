/**
 * Inline-режим: «@бот 12-23 завтра», «@бот неделя», «@бот поток 24 послезавтра»,
 * «@бот общие». Работает в любом чате, включая группы, и вставляет обычное
 * сообщение с расписанием — тем же текстом, что и в личке.
 *
 * Разбор запроса нарочно свободный: слова можно писать в любом порядке, дату —
 * словом («послепослезавтра») или числом («25.09»), группу — как угодно
 * («12-23», «виш 12 23»). Чего не хватает, берётся из настроек человека.
 */
import type { InlineQueryResultArticle } from "grammy/types";
import type { Deps } from "./context.js";
import type { User } from "../db/repo.js";
import { dayView, weekView } from "./views.js";
import { findGroup, type LogicalGroup } from "../schedule/groups.js";
import { clampHtml, filterSubgroup } from "../schedule/format.js";
import { commonLessons, formatCommonLessons, formatStreamDay, mergeStream } from "../schedule/stream.js";
import type { Occurrence } from "../schedule/model.js";
import { addDays, fmtDDMM, mondayOf, parseDayWord, parseRuDate, todayMsk, weekdayShort, type LocalDate } from "../time.js";

export type InlineMode = "auto" | "day" | "week" | "stream" | "common";

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
}

const WEEK_WORDS = /^(нед|недел[а-яё]*|week)$/iu;
const NEXT_WORDS = /^(след|следующая|следующую|next)$/iu;
const STREAM_WORDS = /^(поток[а-яё]*|курс|stream)$/iu;
const COMMON_WORDS = /^(общ[а-яё]+|вместе|common)$/iu;
const DAY_WORDS = /^(пара|пары|день|дня)$/iu;

/** Разбирает inline-запрос: режим, дату и группу. */
export function parseInlineQuery(deps: Deps, query: string, user: User | null): InlineRequest {
  const today = todayMsk();
  const words = query.trim().split(/\s+/).filter(Boolean);
  let mode: InlineMode = "auto";
  let date = today;
  let dateSet = false;
  let nextWeek = false;
  const rest: string[] = [];
  for (const w of words) {
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
  const groups = groupQuery ? findGroup(deps.service.groups(), groupQuery) : [];
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
  const out: InlineQueryResultArticle[] = [];
  const dayTitle = (g: LogicalGroup, date: LocalDate): string => `${g.title} · ${date === today ? "сегодня" : date === addDays(today, 1) ? "завтра" : `${weekdayShort(date)} ${fmtDDMM(date)}`}`;

  const addDay = (g: LogicalGroup): void => {
    const { text } = dayView(deps, g, req.date, own && g.key === own.key ? subgroup : null);
    out.push(article(`d:${g.key}:${req.date}`, `📅 ${dayTitle(g, req.date)}`, text));
  };
  const addWeek = (g: LogicalGroup): void => {
    const { text, monday } = weekView(deps, g, req.date, own && g.key === own.key ? subgroup : null);
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
    const text = formatStreamDay(intake, req.date, rows, deps.service.weekInfo(req.date), today, own?.intake === intake ? own.key : null);
    out.push(article(`s:${intake}:${req.date}`, `🎓 Поток 20${intake} · ${req.date === today ? "сегодня" : fmtDDMM(req.date)}`, text));
  };
  const addCommon = (intake: number): void => {
    const monday = mondayOf(req.date);
    const { rows } = streamWeek(intake, monday);
    const ownInStream = own && own.intake === intake ? own : null;
    const text = formatCommonLessons(intake, monday, rows, ownInStream);
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
  return out.slice(0, 20);
}

/** Подсказка в самом верху inline-списка: что вообще можно написать. */
export const INLINE_HINT = "12-23 завтра · неделя · поток 24 · общие · 25.09 · послепослезавтра";
