import type { InputFile } from "grammy";
import type { BotContext, Deps } from "./context.js";
import { dayNav, weekNav } from "./keyboards.js";
import { esc, filterSubgroup, formatDay, formatWeek } from "../schedule/format.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../time.js";
import type { Occurrence } from "../schedule/model.js";
import { InputFile as GrammyInputFile } from "grammy";
import { logger } from "../logger.js";

export function needGroup(ctx: BotContext): LogicalGroup | null {
  const key = ctx.user.groupKey;
  if (!key) return null;
  return ctx.deps.service.group(key);
}

export function dayView(deps: Deps, group: LogicalGroup, date: LocalDate, subgroup: number | null): { text: string; lessons: Occurrence[] } {
  const today = todayMsk();
  const lessons = deps.service.lessonsOn(group, date);
  const text = formatDay(group, date, lessons, deps.service.weekInfo(date), today, { subgroup, now: wallClock() });
  return { text, lessons: filterSubgroup(lessons, subgroup) };
}

export function weekView(deps: Deps, group: LogicalGroup, anyDate: LocalDate, subgroup: number | null): { text: string; monday: LocalDate; byDate: Map<LocalDate, Occurrence[]> } {
  const monday = mondayOf(anyDate);
  const sunday = addDays(monday, 6);
  const all = deps.service.materialize(group, monday, sunday);
  const byDate = new Map<LocalDate, Occurrence[]>();
  for (const o of all) {
    const list = byDate.get(o.date) ?? [];
    list.push(o);
    byDate.set(o.date, list);
  }
  const text = formatWeek(group, monday, byDate, deps.service.weekInfo(monday), todayMsk(), { subgroup });
  return { text, monday, byDate };
}

/** Send or edit a day view according to the user's format preference. */
export async function sendDay(ctx: BotContext, group: LogicalGroup, date: LocalDate, opts: { edit?: boolean; forceImage?: boolean } = {}): Promise<void> {
  const deps = ctx.deps;
  const subgroup = ctx.user.subgroup;
  const { text, lessons } = dayView(deps, group, date, subgroup);
  const today = todayMsk();
  const hasImages = !!deps.renderer;
  const wantImage = hasImages && (opts.forceImage || ctx.user.format === "image");
  const keyboard = dayNav(date, today, { image: hasImages && !wantImage });

  if (wantImage && deps.renderer) {
    try {
      const png = await deps.renderer.renderDay({ group, date, lessons, weekInfo: deps.service.weekInfo(date), today, now: wallClock() });
      const caption = text.length <= 1000 ? text : undefined;
      await ctx.replyWithPhoto(new GrammyInputFile(png, `${group.title}-${date}.png`), { caption, parse_mode: "HTML", reply_markup: dayNav(date, today, { image: false }) });
      return;
    } catch (err) {
      logger.warn({ err }, "day image render failed, falling back to text");
    }
  }
  if (opts.edit && ctx.callbackQuery?.message && !ctx.callbackQuery.message.photo) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch (err) {
      if (!String(err).includes("message is not modified")) logger.debug({ err }, "edit failed, sending new message");
      else return;
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  if (hasImages && ctx.user.format === "both" && lessons.length > 0 && !opts.edit) {
    // "both": the text goes first, the poster follows silently.
    try {
      const png = await deps.renderer!.renderDay({ group, date, lessons, weekInfo: deps.service.weekInfo(date), today, now: wallClock() });
      await ctx.replyWithPhoto(new GrammyInputFile(png, `${group.title}-${date}.png`), { disable_notification: true });
    } catch (err) {
      logger.warn({ err }, "day image render failed");
    }
  }
}

export async function sendWeek(ctx: BotContext, group: LogicalGroup, anyDate: LocalDate, opts: { edit?: boolean; forceImage?: boolean } = {}): Promise<void> {
  const deps = ctx.deps;
  const { text, monday, byDate } = weekView(deps, group, anyDate, ctx.user.subgroup);
  const hasImages = !!deps.renderer;
  const wantImage = hasImages && (opts.forceImage || ctx.user.format === "image");
  if (wantImage && deps.renderer) {
    try {
      const png = await deps.renderer.renderWeek({ group, monday, byDate, weekInfo: deps.service.weekInfo(monday), today: todayMsk(), subgroup: ctx.user.subgroup });
      await ctx.replyWithPhoto(new GrammyInputFile(png, `${group.title}-week-${monday}.png`), { reply_markup: weekNav(monday, { image: false }) });
      return;
    } catch (err) {
      logger.warn({ err }, "week image render failed, falling back to text");
    }
  }
  const keyboard = weekNav(monday, { image: hasImages && !wantImage });
  if (opts.edit && ctx.callbackQuery?.message && !ctx.callbackQuery.message.photo) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

export function groupRequiredText(): string {
  return `Сначала выбери свою группу: /group`;
}

export function helpText(deps: Deps): string {
  const lines = [
    "<b>Что умеет бот</b>",
    "",
    "📅 <b>Сегодня / Завтра</b> — пары на день, стрелками листаются соседние дни.",
    "🗓 <b>Неделя</b> — вся неделя одним сообщением.",
    "📆 Напиши дату, например <code>14.09</code>, и получишь расписание на неё.",
    "🔔 <b>Изменения</b> — что поменялось в расписании твоей группы за последнее время.",
    "⚙️ <b>Настройки</b> — группа, подгруппа, уведомления об изменениях, напоминания за N часов до первой пары, перед каждой парой, вечером на завтра, тихие часы, темы новостей.",
    "📨 <b>Отправить новость</b> — твоя новость, достижение или объявление уйдёт медиа-ВИШ.",
    "👨‍🏫 <b>Преподаватели</b> — расписание любого преподавателя по фамилии.",
    "🎓 <b>Поток</b> — все группы курса сразу и общие пары с твоей группой.",
    "📆 /calendar — файл с парами до конца семестра для календаря телефона, можно с будильником.",
    "",
    "Бот сам проверяет портал tt.chuvsu.ru каждые несколько минут и присылает изменения только по твоей группе.",
    "",
    "Команды: /today /tomorrow /week /group /teachers /stream /settings /changes /suggest /help",
  ];
  if (deps.ask) lines.push("💬 /ask &lt;вопрос&gt; — спросить про расписание своими словами.");
  lines.push("", `Группы, которые бот знает: ${deps.service.groups().length}. Портал опрошен: ${lastPoll(deps)}.`);
  return lines.join("\n");
}

export function lastPoll(deps: Deps): string {
  const p = deps.repo.lastPollRun();
  if (!p?.finishedAt) return "ещё нет";
  const ago = Math.round((Date.now() - Date.parse(p.finishedAt)) / 60_000);
  return `${ago} мин назад${p.ok ? "" : " (ошибка)"}`;
}

export function subgroupHint(): string {
  return "Подгруппы нужны только для пар, где портал делит группу на 1 и 2 подгруппы (обычно лабораторные). Если выбрать свою, чужие лабы исчезнут из расписания.";
}

export function escapeHtml(s: string): string {
  return esc(s);
}

export type { InputFile };
