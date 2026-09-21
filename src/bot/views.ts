import { InputFile, InputMediaBuilder } from "grammy";
import type { BotContext, Deps } from "./context.js";
import { BTN, dayNav, weekNav } from "./keyboards.js";
import { clampHtml, esc, filterSubgroup, formatDay, formatWeek } from "../schedule/format.js";
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
      const png = await deps.renderer.renderDay({ group, date, lessons, weekInfo: deps.service.weekInfo(date), today, now: wallClock(), theme: ctx.user.posterTheme ?? undefined });
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
      await ctx.editMessageText(clampHtml(text), { parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
      logger.debug({ err: String(err) }, "edit failed, sending new message");
    }
  }
  // Сессионная неделя с консультациями перерастает лимит Telegram в 4096:
  // без обрезки падал бы весь ответ, а человек не получал ничего.
  await ctx.reply(clampHtml(text), { parse_mode: "HTML", reply_markup: keyboard });
  if (hasImages && ctx.user.format === "both" && lessons.length > 0 && !opts.edit) {
    // "both": the text goes first, the poster follows silently with its own navigation.
    try {
      const png = await deps.renderer!.renderDay({ group, date, lessons, weekInfo: deps.service.weekInfo(date), today, now: wallClock(), theme: ctx.user.posterTheme ?? undefined });
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
      const png = await deps.renderer.renderWeek({ group, monday, byDate, weekInfo: deps.service.weekInfo(monday), today: todayMsk(), subgroup, theme: ctx.user.posterTheme ?? undefined });
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
      await ctx.editMessageText(clampHtml(text), { parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(clampHtml(text), { parse_mode: "HTML", reply_markup: keyboard });
}

export function groupRequiredText(): string {
  return `Сначала выбери свою группу: /group`;
}

/** "каждые 6 минут" straight from POLL_CRON_BUSY, so the text cannot drift from the setting. */
function pollCadence(deps: Deps): string {
  const m = /^\*\/(\d+)\s/.exec(deps.config.POLL_CRON_BUSY);
  const n = m ? Number(m[1]) : 0;
  if (!n) return "регулярно";
  const word = n % 10 === 1 && n % 100 !== 11 ? "минуту" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "минуты" : "минут";
  return `каждые ${n} ${word}`;
}

/** Calendar subscriptions need both a public address and a listening feed server. */
function subscriptionsLive(deps: Deps): boolean {
  return !!deps.config.PUBLIC_URL && deps.http?.listening === true;
}

/**
 * «Функции» — карта бота простыми словами: что есть, где нажать, что получится.
 * Возвращает куски по одному сообщению: всё вместе давно не влезает в лимит
 * Telegram, а резать карту на полуслове нельзя.
 */
export function featuresSections(deps: Deps, opts: { admin?: boolean } = {}): string[] {
  const bot = deps.botUsername ?? "бот";
  const poisk = !!deps.students && deps.config.POISK;
  const first = [
    "<b>🧭 Карта бота</b>",
    "<i>Всё, что он умеет, по-человечески. Кнопки — внизу экрана, команды можно писать прямо в чат.</i>",
    "",
    "<b>📅 Расписание</b>",
    `• ${BTN.today} и ${BTN.tomorrow} — пары на день: время начала и конца, аудитория, тип пары. Стрелки под сообщением листают дни, не засоряя чат.`,
    "• Дату можно просто написать словом или числом: <code>послезавтра</code>, <code>позавчера</code>, <code>послепослезавтра</code> (это +3 дня), <code>14.09</code>.",
    `• ${BTN.week} и ${BTN.nextWeek} — вся неделя одним экраном, с пометкой чётной и нечётной.`,
    `• ${BTN.otherGroups} — расписание любой другой группы; твоя при этом не меняется.`,
    `• ${BTN.stream} — весь поток сразу: где какая группа, мини-кнопки по группам, «${BTN.streamCommon}» — лекции, на которых вы сидите вместе.`,
    "• «🖼 Картинкой» — тот же день или неделя постером. В настройках выбирается оформление: тёмное, журнальное, плакатное или лента.",
    "",
    "<b>👨‍🏫 Преподаватели</b>",
    `• ${BTN.teachers} — найди по фамилии (опечатки бот прощает и предложит похожих). Покажет день, неделю и фото, а рядом с теми, кто ведёт у нас, стоит пометка <b>(ВИШ)</b> — в университете есть полные тёзки.`,
    "• «👁 Следить за преподом» — вечером придёт его завтрашний день, и ещё раз за 2 часа до его первой пары.",
    ...(poisk
      ? [
          "",
          "<b>🕵️ Где студент</b>",
          "• Кнопка внизу списка групп в «👥 Др. группы» и в режиме потока. По ФИО находит группу человека и показывает, где он должен быть сейчас по расписанию. Это расписание его группы, а не слежка.",
        ]
      : []),
  ];

  const second = [
    "<b>🔔 Что бот присылает сам</b>",
    `• ${BTN.changes} — изменения в расписании твоей группы: переносы, замены аудиторий, отмены, новые пары. Портал бот проверяет ${pollCadence(deps)} в учебное время и раз в полчаса в остальное. В каждом таком сообщении есть кнопка «📆 Файл изменений в календарь».`,
    "• Доска объявлений ВИШ — там же, в «Изменениях». Туда админ вешает только важное: дистант, отмены, дедлайны.",
    "• Напоминания настраиваются по отдельности: до первой пары, перед каждой парой, за 5 минут до дистанта (со ссылкой на вебинар, преподавателем и темой), вечером про завтра.",
    "• Тихие часы — ночью бот молчит, а утром отдаёт накопившееся одним сообщением.",
    "• Можно следить за чужими группами и за преподавателями — уведомления придут и по ним.",
    "• Темы рассылок: конкурсы и стипендии, объявления (включены сразу — там только важное), события ВИШ.",
    "",
    "<b>🛠 Инструменты</b>",
    `• ${BTN.calendar} — пары в календарь телефона: ${subscriptionsLive(deps) ? "ссылка-подписка (обновляется сама, ничего не дублирует) или файл .ics с будильником" : "файл .ics, можно с будильником"}. Отдельно можно забрать только изменения.`,
    `• ${BTN.search} — одна строка на всё: группа, предмет, преподаватель${poisk ? ", студент" : ""}. ${deps.ask ? "Отвечает ИИ и подписывает, кого нашёл, а кнопками можно сразу открыть расписание." : "Бот найдёт совпадения и покажет кнопки."}`,
    ...(deps.ask ? ["• 💬 /ask — спросить своими словами: «когда матан?», «кто ведёт БЖД», «что у 14-24 в пятницу», «как включить напоминания»."] : []),
    `• ${BTN.settings} — группа, подгруппа, формат (текст, картинка или оба), оформление картинок, все уведомления, слежения.`,
    "• 📨 /suggest — отправить новость или достижение медиа-ВИШ.",
    "• 🧹 /soon — стереть все свои данные; после этого /start начнётся с нуля.",
    ...(deps.inline
      ? [`\n<b>💬 В любом чате (inline)</b>\nНапиши <code>@${bot} 12-23 завтра</code> — и выбери, что вставить: день, неделю, поток или общие пары. Работает и в группах, бот туда добавлять не нужно. Примеры: <code>@${bot} неделя</code>, <code>@${bot} поток 24</code>, <code>@${bot} общие</code>, <code>@${bot} 25.09</code>.`]
      : []),
    ...(opts.admin ? ["\n<b>🛡 Админу</b>\n/admin — статистика, здоровье, рассылка, доска объявлений, лимиты ИИ, источники новостей. /poll — опросить портал сейчас. /ailimit — квоты ИИ."] : []),
  ];

  const notes: string[] = [];
  if (!deps.teachers) notes.push("Полное расписание преподавателей портал показывает только авторизованным, поэтому пока бот знает их по дистанционным парам.");
  notes.push(`Групп в боте: ${deps.service.groups().length}. Портал опрошен: ${lastPoll(deps)}.`);
  second.push("", `<i>${notes.join(" ")}</i>`);
  return [first.join("\n"), second.join("\n")];
}

/** Один текст для тех мест, где нужно всё сразу (например, подсказка для ИИ). */
export function featuresText(deps: Deps, opts: { admin?: boolean } = {}): string {
  return featuresSections(deps, opts).join("\n\n");
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
