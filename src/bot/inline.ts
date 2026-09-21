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
import { filterSubgroup } from "../schedule/format.js";
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
}

const WEEK_WORDS = /^(неделя|неделю|нед|недел\w*|week)$/iu;
const NEXT_WORDS = /^(след|следующая|следующую|next)$/iu;
const STREAM_WORDS = /^(поток|потока|курс|stream)$/iu;
const COMMON_WORDS = /^(общие|общая|общее|общих|вместе|common)$/iu;
const DAY_WORDS = /^(пара|пары|день|сегодня|завтра|вчера|(после|поза)+(завтра|вчера))$/iu;

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
  // «поток 24» — это год набора, а не группа.
  const intakeWord = rest.find((w) => /^\d{2}$/.test(w));
  const intake = intakeWord && deps.service.intakes().includes(Number(intakeWord)) ? Number(intakeWord) : null;
  const own = user?.groupKey ? deps.service.group(user.groupKey) : null;
  const effective = groups.length ? groups : own ? [own] : deps.service.groups().slice(0, 4);
  return { mode, date, groups: effective, intake: intake ?? (mode === "stream" || mode === "common" ? (own?.intake ?? deps.service.intakes()[0] ?? null) : null), empty: words.length === 0 };
}

const cut = (s: string, n = 4000): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

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

function article(id: string, title: string, text: string): InlineQueryResultArticle {
  return {
    type: "article",
    // id ограничен 64 байтами: кириллица — два байта на букву, поэтому режем.
    id: Buffer.from(id).subarray(0, 64).toString(),
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
  const addStream = (intake: number): void => {
    const { rows } = streamRows(deps, intake, req.date, req.date, own, subgroup);
    const text = formatStreamDay(intake, req.date, rows, deps.service.weekInfo(req.date), today, own?.intake === intake ? own.key : null);
    out.push(article(`s:${intake}:${req.date}`, `🎓 Поток 20${intake} · ${req.date === today ? "сегодня" : fmtDDMM(req.date)}`, text));
  };
  const addCommon = (intake: number): void => {
    const monday = mondayOf(req.date);
    const { rows } = streamRows(deps, intake, monday, addDays(monday, 6), own, subgroup);
    const ownInStream = own && own.intake === intake ? own : null;
    const text = formatCommonLessons(intake, monday, rows, ownInStream);
    if (!commonLessons(rows, ownInStream?.key ?? null).length && !ownInStream) return;
    out.push(article(`c:${intake}:${monday}`, `🤝 Общие пары · поток 20${intake}`, text));
  };

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
