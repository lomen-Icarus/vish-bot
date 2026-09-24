/**
 * Панель предметов (тестово, только командой): /subjects — предметы своей
 * группы за семестр, нажал на предмет — все его пары таблицей: даты, тип
 * (ЛК/ПР/ЛБ), время, аудитория, сколько прошло и сколько осталось.
 *
 * /subjects 14-24 — то же по другой группе. В режиме преподавателя — по его
 * собственным парам.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { findGroup } from "../../schedule/groups.js";
import { clampHtml, esc, filterSubgroup } from "../../schedule/format.js";
import { lessonTypeLabel, PERIOD_NAMES } from "../../schedule/model.js";
import { SEMESTER_WEEKS } from "../../schedule/service.js";
import { formatSubjectTable, summarizeSubjects, typeCounts, type SubjectSummary } from "../../schedule/subjects.js";
import { addDays, todayMsk, wallClock, type LocalDate } from "../../time.js";
import { groupLessons, groupRequiredText } from "../views.js";
import { ownTeacherRef } from "../teacherMode.js";
import { loadProfile, profileLessons } from "../../people/profile.js";
import { refKey } from "../../people/ref.js";
import { shortName } from "../../text/match.js";
import { logger } from "../../logger.js";

export const subjectHandlers = new Composer<BotContext>();

/** Чьи предметы человек смотрит сейчас: своя группа, другая группа или он сам (преподаватель). */
type Source = { kind: "group"; key: string } | { kind: "teacher" };

/**
 * Последний /subjects человека. Ключ группы в callback_data рядом с ключом
 * предмета не влезает, поэтому помним здесь; после перезапуска — своя группа.
 */
const lastSource = new Map<number, Source>();

/** Семестр целиком, с хвостом на сессию: так видно и прошедшие пары, и зачёты. */
function semesterWindow(ctx: BotContext, today: LocalDate): { from: LocalDate; to: LocalDate; label: string } {
  const service = ctx.deps.service;
  const semester = service.semesterFor(today);
  const anchor = service.weekOneMonday(semester);
  return {
    from: anchor ?? addDays(today, -60),
    to: anchor ? addDays(anchor, SEMESTER_WEEKS * 7 + 27) : addDays(today, 120),
    label: PERIOD_NAMES[semester],
  };
}

function ownSource(ctx: BotContext): Source | null {
  if (ctx.user.teacherMode) return { kind: "teacher" };
  return ctx.user.groupKey ? { kind: "group", key: ctx.user.groupKey } : null;
}

async function loadSubjects(ctx: BotContext, source: Source): Promise<{ owner: string; label: string; subjects: SubjectSummary[] } | null> {
  const today = todayMsk();
  const { from, to, label } = semesterWindow(ctx, today);
  if (source.kind === "group") {
    const group = ctx.deps.service.group(source.key);
    if (!group) return null;
    const own = group.key === ctx.user.groupKey;
    const lessons = filterSubgroup(groupLessons(ctx.deps, group, from, to), own ? ctx.user.subgroup : null);
    return { owner: group.title, label, subjects: summarizeSubjects(lessons) };
  }
  const ref = ownTeacherRef(ctx.user);
  if (!ref) return null;
  try {
    const profile = await loadProfile(ctx.deps, ref);
    if (!profile) return null;
    const loaded = await profileLessons(ctx.deps, profile, from, to);
    if (loaded.failed) return null;
    return { owner: shortName(loaded.fullName ?? profile.name), label, subjects: summarizeSubjects(loaded.lessons) };
  } catch (err) {
    logger.warn({ err: String(err), ref: refKey(ref) }, "subjects: teacher lessons failed");
    return null;
  }
}

function listKeyboard(subjects: SubjectSummary[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  // row() только между кнопками: пустой хвостовой ряд Telegram не примет.
  subjects.forEach((s, i) => {
    if (i) kb.row();
    kb.text(`${s.subject} · ${s.lessons.length}`.slice(0, 56), `sj:${s.key}`);
  });
  return kb;
}

function detailKeyboard(s: SubjectSummary, type: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  const types = typeCounts(s.lessons).map(([t]) => t);
  if (types.length > 1) {
    kb.text(type ? "Все" : "• Все •", `sj:${s.key}`);
    for (const t of types) kb.text(t === type ? `• ${lessonTypeLabel(t)} •` : lessonTypeLabel(t), `sj:${s.key}:${t}`);
    kb.row();
  }
  return kb.text("◀️ К предметам", "sj:list");
}

async function reply(ctx: BotContext, text: string, kb: InlineKeyboard, edit: boolean): Promise<void> {
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(clampHtml(text), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(clampHtml(text), { parse_mode: "HTML", reply_markup: kb });
}

async function showList(ctx: BotContext, source: Source, edit = false): Promise<void> {
  const loaded = await loadSubjects(ctx, source);
  if (!loaded) return void (await ctx.reply(source.kind === "teacher" ? "Твоего расписания сейчас не видно: портал не ответил или тебя нет в справочнике. Попробуй позже." : "Группа не найдена, список групп обновился."));
  if (!loaded.subjects.length) return void (await reply(ctx, `📚 <b>Предметы · ${esc(loaded.owner)}</b>\n\nВ этом семестре пар пока нет.`, new InlineKeyboard(), edit));
  const total = loaded.subjects.reduce((n, s) => n + s.lessons.length, 0);
  const text = `📚 <b>Предметы · ${esc(loaded.owner)}</b>\n<i>${esc(loaded.label)}: ${loaded.subjects.length} предметов, ${total} пар</i>\n\nВыбери предмет — покажу все его пары: даты, тип (ЛК, ПР, ЛБ), сколько прошло и сколько осталось.`;
  await reply(ctx, text, listKeyboard(loaded.subjects), edit);
}

subjectHandlers.command(["subjects", "predmety"], async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  let source: Source | null;
  if (arg) {
    const found = findGroup(ctx.deps.service.groups(), arg);
    if (found.length !== 1) return void (await ctx.reply(found.length ? "Под это подходит несколько групп — напиши точнее, например <code>/subjects 11-23 ЭиЭА</code>." : "Не нашёл такую группу. Например: <code>/subjects 14-24</code>.", { parse_mode: "HTML" }));
    source = { kind: "group", key: found[0]!.key };
  } else {
    source = ownSource(ctx);
    if (!source) return void (await ctx.reply(groupRequiredText()));
  }
  lastSource.set(ctx.from!.id, source);
  await showList(ctx, source);
});

subjectHandlers.callbackQuery("sj:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const source = lastSource.get(ctx.from.id) ?? ownSource(ctx);
  if (!source) return void (await ctx.reply(groupRequiredText()));
  await showList(ctx, source, true);
});

subjectHandlers.callbackQuery(/^sj:([A-Za-z0-9_-]{10})(?::(.+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const source = lastSource.get(ctx.from.id) ?? ownSource(ctx);
  if (!source) return void (await ctx.reply(groupRequiredText()));
  const loaded = await loadSubjects(ctx, source);
  const s = loaded?.subjects.find((x) => x.key === ctx.match[1]);
  if (!loaded || !s) return void (await ctx.reply("Список предметов устарел — набери /subjects ещё раз."));
  const type = ctx.match[2] ?? null;
  const now = wallClock();
  await reply(ctx, formatSubjectTable(s, { owner: loaded.owner, periodLabel: loaded.label, today: now.date, nowMinutes: now.minutes, type }), detailKeyboard(s, type), true);
});
