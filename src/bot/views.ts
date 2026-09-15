import { InputFile, InputMediaBuilder } from "grammy";
import type { BotContext, Deps } from "./context.js";
import { BTN, dayNav, weekNav } from "./keyboards.js";
import { esc, filterSubgroup, formatDay, formatWeek } from "../schedule/format.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../time.js";
import type { Occurrence } from "../schedule/model.js";
import { logger } from "../logger.js";

export function needGroup(ctx: BotContext): LogicalGroup | null {
  const key = ctx.user.groupKey;
  if (!key) return null;
  return ctx.deps.service.group(key);
}

/** Fill in the teacher and the topic of online lessons from the portal's webinar page. */
function withWebinars(deps: Deps, group: LogicalGroup, lessons: Occurrence[]): Occurrence[] {
  if (!deps.webinars) return lessons;
  try {
    return deps.webinars.enrich(lessons, [group.title, ...group.portalNames]);
  } catch (err) {
    logger.debug({ err: String(err) }, "webinar enrichment failed");
    return lessons;
  }
}

export function dayView(deps: Deps, group: LogicalGroup, date: LocalDate, subgroup: number | null): { text: string; lessons: Occurrence[] } {
  const today = todayMsk();
  const lessons = withWebinars(deps, group, deps.service.lessonsOn(group, date));
  const text = formatDay(group, date, lessons, deps.service.weekInfo(date), today, { subgroup, now: wallClock() });
  return { text, lessons: filterSubgroup(lessons, subgroup) };
}

export function weekView(deps: Deps, group: LogicalGroup, anyDate: LocalDate, subgroup: number | null): { text: string; monday: LocalDate; byDate: Map<LocalDate, Occurrence[]> } {
  const monday = mondayOf(anyDate);
  const sunday = addDays(monday, 6);
  const all = withWebinars(deps, group, deps.service.materialize(group, monday, sunday));
  const byDate = new Map<LocalDate, Occurrence[]>();
  for (const o of all) {
    const list = byDate.get(o.date) ?? [];
    list.push(o);
    byDate.set(o.date, list);
  }
  const text = formatWeek(group, monday, byDate, deps.service.weekInfo(monday), todayMsk(), { subgroup });
  return { text, monday, byDate };
}

interface SendOpts {
  edit?: boolean;
  forceImage?: boolean;
  /** Viewing a group that is not the user's own: navigation carries the group key. */
  peek?: boolean;
}

export function isPhotoMessage(ctx: BotContext): boolean {
  return !!ctx.callbackQuery?.message && "photo" in ctx.callbackQuery.message && !!ctx.callbackQuery.message.photo;
}

/** Replace the photo of the message the callback came from (poster navigation in place). */
export async function editPhoto(ctx: BotContext, png: Buffer, fileName: string, caption: string | undefined, replyMarkup: Parameters<BotContext["editMessageMedia"]>[1] extends infer T ? (T extends { reply_markup?: infer R } ? R : never) : never): Promise<boolean> {
  try {
    await ctx.editMessageMedia(InputMediaBuilder.photo(new InputFile(png, fileName), caption ? { caption, parse_mode: "HTML" } : {}), { reply_markup: replyMarkup });
    return true;
  } catch (err) {
    if (String(err).includes("message is not modified")) return true;
    logger.debug({ err: String(err) }, "editMessageMedia failed");
    return false;
  }
}

/** Send or edit a day view according to the user's format preference. */
export async function sendDay(ctx: BotContext, group: LogicalGroup, date: LocalDate, opts: SendOpts = {}): Promise<void> {
  const deps = ctx.deps;
  const own = group.key === ctx.user.groupKey;
  const subgroup = own ? ctx.user.subgroup : null;
  const peekKey = opts.peek || !own ? group.key : undefined;
  const { text, lessons } = dayView(deps, group, date, subgroup);
  const today = todayMsk();
  const hasImages = !!deps.renderer;
  const photoMsg = !!opts.edit && isPhotoMessage(ctx);
  const wantImage = hasImages && (opts.forceImage || ctx.user.format === "image" || photoMsg);
  const fileName = `${group.title}-${date}.png`;

  if (wantImage && deps.renderer) {
    try {
      const png = await deps.renderer.renderDay({ group, date, lessons, weekInfo: deps.service.weekInfo(date), today, now: wallClock() });
      const caption = text.length <= 1000 ? text : undefined;
      const kb = dayNav(date, today, { image: false, peekKey });
      if (photoMsg && (await editPhoto(ctx, png, fileName, caption, kb))) return;
      await ctx.replyWithPhoto(new InputFile(png, fileName), { caption, parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      logger.warn({ err: String(err) }, "day image render failed, falling back to text");
    }
  }
  const keyboard = dayNav(date, today, { image: hasImages, peekKey });
  if (opts.edit && ctx.callbackQuery?.message && !photoMsg) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
      logger.debug({ err: String(err) }, "edit failed, sending new message");
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  if (hasImages && ctx.user.format === "both" && lessons.length > 0 && !opts.edit) {
    // "both": the text goes first, the poster follows silently with its own navigation.
    try {
      const png = await deps.renderer!.renderDay({ group, date, lessons, weekInfo: deps.service.weekInfo(date), today, now: wallClock() });
      await ctx.replyWithPhoto(new InputFile(png, fileName), { disable_notification: true, reply_markup: dayNav(date, today, { image: false, peekKey }) });
    } catch (err) {
      logger.warn({ err: String(err) }, "day image render failed");
    }
  }
}

export async function sendWeek(ctx: BotContext, group: LogicalGroup, anyDate: LocalDate, opts: SendOpts = {}): Promise<void> {
  const deps = ctx.deps;
  const own = group.key === ctx.user.groupKey;
  const subgroup = own ? ctx.user.subgroup : null;
  const peekKey = opts.peek || !own ? group.key : undefined;
  const { text, monday, byDate } = weekView(deps, group, anyDate, subgroup);
  const hasImages = !!deps.renderer;
  const photoMsg = !!opts.edit && isPhotoMessage(ctx);
  const wantImage = hasImages && (opts.forceImage || ctx.user.format === "image" || photoMsg);
  const fileName = `${group.title}-week-${monday}.png`;
  if (wantImage && deps.renderer) {
    try {
      const png = await deps.renderer.renderWeek({ group, monday, byDate, weekInfo: deps.service.weekInfo(monday), today: todayMsk(), subgroup });
      const kb = weekNav(monday, { image: false, peekKey });
      if (photoMsg && (await editPhoto(ctx, png, fileName, undefined, kb))) return;
      await ctx.replyWithPhoto(new InputFile(png, fileName), { reply_markup: kb });
      return;
    } catch (err) {
      logger.warn({ err: String(err) }, "week image render failed, falling back to text");
    }
  }
  const keyboard = weekNav(monday, { image: hasImages, peekKey });
  if (opts.edit && ctx.callbackQuery?.message && !photoMsg) {
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

/** Calendar subscriptions need both a public address and a listening feed server. */
function subscriptionsLive(deps: Deps): boolean {
  return !!deps.config.PUBLIC_URL && deps.http?.listening === true;
}

/** The "Функции" screen: everything a student can do, grouped. */
export function featuresText(deps: Deps): string {
  const lines = [
    "<b>🧭 Что умеет бот</b>",
    "",
    "<b>Расписание</b>",
    `${BTN.today} / ${BTN.tomorrow} — пары на день. Стрелки листают соседние дни прямо в этом же сообщении, «🖼 Картинкой» рисует постер.`,
    `${BTN.week} / ${BTN.nextWeek} — вся неделя одним экраном, с постером и экспортом в календарь.`,
    `${BTN.otherGroups} — расписание любой группы ВИШ, своя группа при этом не меняется.`,
    `${BTN.stream} — весь курс сразу: общие лекции, мини-кнопки групп, «🤝 Общие пары».`,
    `${BTN.teachers} — кто ведёт и когда.`,
    "Можно просто написать дату: <code>14.09</code>.",
    "",
    "<b>Уведомления</b>",
    `${BTN.changes} — доска объявлений ВИШ и изменения в расписании твоей группы: переносы, замены аудиторий, отмены, новые пары. Портал бот проверяет каждые 6 минут.`,
    "Напоминания настраиваются по отдельности: до первой пары, перед каждой парой, за 5 минут до дистанта со ссылкой на вебинар, вечером про завтра. Есть тихие часы — то, что придёт в это время, бот отдаст утром одним сообщением.",
    "Темы рассылок: конкурсы и стипендии, объявления, события ВИШ.",
    "",
    "<b>Инструменты</b>",
    `${BTN.calendar} — пары в календарь телефона${subscriptionsLive(deps) ? ": ссылка-подписка (обновляется сама, ничего не дублируется) или файл .ics с будильником" : " файлом .ics, можно с будильником"}.`,
    `${BTN.search} — найти группу, предмет или преподавателя одним запросом.`,
    `${BTN.settings} — группа, подгруппа, формат (текст/картинка/оба), все уведомления, слежение за другими группами.`,
    "📨 /suggest — отправить новость или достижение медиа-ВИШ.",
  ];
  if (deps.ask) lines.push("💬 /ask — спросить своими словами: «когда матан?», «кто такая Иванова», «что у 14-24 в пятницу».");
  lines.push("", "Inline: напиши в любом чате <code>@бот 12-23 завтра</code> — вставится расписание.");
  const notes: string[] = [];
  if (!deps.teachers) notes.push("Полное расписание преподавателей портал показывает только авторизованным, поэтому бот знает преподавателей по дистанционным парам.");
  notes.push(`Групп в боте: ${deps.service.groups().length}. Портал опрошен: ${lastPoll(deps)}.`);
  lines.push("", notes.join(" "));
  return lines.join("\n");
}

export function helpText(deps: Deps): string {
  return featuresText(deps);
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
