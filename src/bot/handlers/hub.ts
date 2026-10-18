/**
 * Новое нижнее меню 2 × 3: «🔍 Найти», «🗂 Ещё» и «🙋 Поддержка» открывают панели
 * под сообщением. Кнопки панели ведут в те же разделы, что раньше были внизу
 * (группы, поток, преподаватели, изменения, календарь, настройки, справка),
 * поэтому сами разделы не менялись — изменился только вход в них.
 *
 * «🏛 Министерство Жалоб» — написать владельцу бота прямо из бота, в том числе
 * анонимно. Обращение уходит админам (ADMIN_IDS) копией сообщения, а не
 * пересылкой: у пересланного Telegram показывает автора, и аноним бы
 * раскрылся. Номер обращения и кому отвечать бот помнит в support_tickets —
 * без текста; в логе только номера.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, btnLabels, FIND_BTN, isMenuText, MORE_BTN } from "../keyboards.js";
import { needGroup } from "../views.js";
import { esc, plural } from "../../schedule/format.js";
import { logger } from "../../logger.js";
import { promptPeople } from "../people.js";
import { offerCalendar } from "./calendar.js";
import { showFeatures, startSearch } from "./misc.js";
import { renderSettings } from "./settings.js";
import { showChanges, showOtherGroups } from "./schedule.js";
import { enterStream } from "./stream.js";
import { httpsBase } from "../../http/publicUrl.js";

export const hubHandlers = new Composer<BotContext>();

// ---- 🔍 Найти ----
function findPanel(ctx: BotContext): { text: string; kb: InlineKeyboard } {
  const teacher = ctx.user.teacherMode;
  // «Где препод» и «Где студент» — рядом: это один и тот же поиск человека.
  const kb = new InlineKeyboard()
    .text(teacher ? FIND_BTN.teacherGroups : FIND_BTN.groups, "hub:groups")
    .text(FIND_BTN.stream, "hub:stream")
    .row()
    .text(FIND_BTN.teachers, "hub:teachers");
  if (ctx.deps.config.POISK && ctx.deps.students) kb.text(FIND_BTN.poisk, "hub:poisk");
  if (ctx.deps.ask) kb.row().text(FIND_BTN.ask, "hub:ask");
  const text = [
    "🔍 <b>Найти</b>",
    "",
    "Просто напиши, что ищешь: группу (<code>14-24</code>), преподавателя (<code>Иванова</code>), предмет (<code>матан</code>) или дату (<code>15.10</code>).",
    "Или выбери:",
  ].join("\n");
  return { text, kb };
}

async function openFind(ctx: BotContext): Promise<void> {
  const { text, kb } = findPanel(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}
hubHandlers.hears(BTN.find, openFind);

hubHandlers.callbackQuery(/^hub:(groups|stream|teachers|ask|poisk)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  switch (ctx.match[1]) {
    case "groups":
      return showOtherGroups(ctx);
    case "stream":
      return enterStream(ctx);
    case "teachers":
      return promptPeople(ctx, "teacher");
    case "poisk":
      return promptPeople(ctx, "student");
    case "ask":
      return startSearch(ctx);
  }
});

// ---- 🗂 Ещё ----
function morePanel(ctx: BotContext): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard()
    .text(MORE_BTN.changes, "more:changes")
    .row()
    .text(MORE_BTN.calendar, "more:calendar")
    .row()
    .text(MORE_BTN.settings, "more:settings")
    .text(MORE_BTN.help, "more:help");
  // «Записывать мою группу» — форма Mini App; нужен HTTPS-адрес (Telegram иначе не откроет) и включённая запись.
  // Заявка уже в работе или учётка в слоте — та же строка ведёт к статусу и отзыву (один вход на функцию).
  const base = httpsBase(ctx.deps);
  if (ctx.deps.config.SLIDES_TOKEN && ctx.deps.repo.liveRecRequest(ctx.user.id)) kb.row().text(MORE_BTN.recordMe, "rqme");
  else if (base && ctx.deps.config.SLIDES_TOKEN) kb.row().webApp(MORE_BTN.recordNew, `${base}/tma`);
  return { text: "🗂 <b>Ещё</b>", kb };
}

hubHandlers.hears(btnLabels("more"), async (ctx) => {
  const { text, kb } = morePanel(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
});

hubHandlers.callbackQuery(/^more:(changes|calendar|settings|help)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  switch (ctx.match[1]) {
    case "changes":
      return showChanges(ctx);
    case "calendar":
      return offerCalendar(ctx);
    case "settings":
      return renderSettings(ctx, false);
    case "help":
      return showFeatures(ctx);
  }
});

// ---- 🏛 Министерство Жалоб ----
/** Сколько обращений за сутки: анонимные — меньше, их не на кого пожаловаться в ответ. */
const DAILY_LIMIT = { anon: 5, named: 20 } as const;
const SUPPORT_TTL_MS = 15 * 60_000;

function supportText(ctx: BotContext, anon: boolean): string {
  return [
    "🏛 <b>Министерство Жалоб</b>",
    "",
    `Написать можно: ${esc(ctx.deps.config.SUPPORT_CONTACT)}`,
    "Или отправь сообщение ниже — жалобу, ошибку в расписании, идею. Можно текст, фото или скриншот.",
    "",
    anon ? "Сейчас: 🕶 <b>анонимно</b> — в обращении не будет ни ника, ни id. Ответ, если будет, придёт сюда." : "Сейчас: 👤 <b>с твоим ником</b>, чтобы можно было ответить лично.",
  ].join("\n");
}

function supportKeyboard(anon: boolean): InlineKeyboard {
  return new InlineKeyboard().text(anon ? "👤 Отправить с ником" : "🕶 Отправить анонимно", anon ? "sup:named" : "sup:anon").row().text("◀️ Назад", "sup:back");
}

async function openSupport(ctx: BotContext): Promise<void> {
  if (!ctx.deps.config.ADMIN_IDS.length) {
    await ctx.reply(`Написать можно: ${ctx.deps.config.SUPPORT_CONTACT}`);
    return;
  }
  setPending(ctx.deps, ctx.user.id, { kind: "support", anon: false }, SUPPORT_TTL_MS);
  await ctx.reply(supportText(ctx, false), { parse_mode: "HTML", reply_markup: supportKeyboard(false), link_preview_options: { is_disabled: true } });
}
hubHandlers.hears(btnLabels("complaint"), openSupport);
hubHandlers.command("support", openSupport);

hubHandlers.callbackQuery(/^sup:(anon|named|back)$/, async (ctx) => {
  const choice = ctx.match[1];
  if (choice === "back") {
    clearPending(ctx.deps, ctx.user.id);
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => ctx.editMessageText("Закрыто.").catch(() => undefined));
    return;
  }
  const anon = choice === "anon";
  // Уже написанное (ждёт «Отправить») не теряем — меняется только режим.
  const was = takePending(ctx.deps, ctx.user.id);
  const kept = was?.kind === "support" ? { chatId: was.chatId, messageIds: was.messageIds, confirmId: was.confirmId } : {};
  setPending(ctx.deps, ctx.user.id, { kind: "support", anon, ...kept }, SUPPORT_TTL_MS);
  await ctx.answerCallbackQuery({ text: anon ? "Отправлю анонимно" : "Отправлю с твоим ником" });
  if (kept.messageIds?.length) await ctx.editMessageText(confirmText(anon, kept.messageIds.length), { reply_markup: confirmKeyboard(anon) }).catch(() => undefined);
  else await ctx.editMessageText(supportText(ctx, anon), { parse_mode: "HTML", reply_markup: supportKeyboard(anon), link_preview_options: { is_disabled: true } }).catch(() => undefined);
});

/** Сообщений в одном обращении — не больше: дальше это уже переписка, а не жалоба. */
const MAX_TICKET_MESSAGES = 10;

const confirmText = (anon: boolean, count = 1): string =>
  `Отправить ${count > 1 ? `эти ${count} ${plural(count, "сообщение", "сообщения", "сообщений")}` : "это"} в Министерство Жалоб ${anon ? "🕶 анонимно" : "👤 с твоим ником"}?${
    count >= MAX_TICKET_MESSAGES ? ` Больше ${MAX_TICKET_MESSAGES} в одно обращение не войдёт — остальное напиши следующим.` : count > 1 ? "" : " Можно дописать ещё — уйдёт одним обращением."
  }`;
function confirmKeyboard(anon: boolean): InlineKeyboard {
  return new InlineKeyboard().text("✅ Отправить", "sup:send").text("✖️ Не отправлять", "sup:back").row().text(anon ? "👤 Отправить с ником" : "🕶 Отправить анонимно", anon ? "sup:named" : "sup:anon");
}

/**
 * Обращение: любое сообщение — текст, фото, документ, голосовое. Сразу не
 * уходит: «🙋 Поддержка» — постоянная кнопка, её жмут из любопытства, и
 * набранное потом «14-24» иначе улетело бы админу. Поэтому — «Отправить?».
 * Несколько сообщений подряд (текст, потом скриншот) — одно обращение:
 * вопрос «Отправить?» переезжает под последнее, уходят все.
 */
hubHandlers.on("message", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || (pending.kind !== "support" && pending.kind !== "support-reply")) return next();
  if (ctx.msg.text?.startsWith("/")) return next();
  // Кнопка меню — человек передумал: выходим из режима, кнопка работает как обычно.
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  if (pending.kind === "support-reply") {
    clearPending(ctx.deps, ctx.user.id);
    return void (await relayReply(ctx, pending.ticket ?? 0));
  }
  const anon = !!pending.anon;
  const was = pending.messageIds ?? [];
  // Сверх лимита — не добавляем: первые сообщения обычно и есть суть жалобы.
  if (was.length >= MAX_TICKET_MESSAGES) {
    await ctx.reply(`В одном обращении — до ${MAX_TICKET_MESSAGES} сообщений. Отправь эти кнопкой выше, а это — следующим обращением.`);
    return;
  }
  const messageIds = [...was, ctx.msg.message_id];
  // Сначала запоминаем сообщение, потом задаём вопрос: не дошёл вопрос —
  // сообщение всё равно в обращении, кнопка «Отправить» прежнего вопроса работает.
  setPending(ctx.deps, ctx.user.id, { ...pending, kind: "support", anon, chatId: ctx.chat.id, messageIds }, SUPPORT_TTL_MS);
  const confirm = await ctx.reply(confirmText(anon, messageIds.length), { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true }, reply_markup: confirmKeyboard(anon) });
  if (pending.confirmId) await ctx.api.deleteMessage(ctx.chat.id, pending.confirmId).catch(() => undefined);
  const now = takePending(ctx.deps, ctx.user.id);
  if (now?.kind === "support") setPending(ctx.deps, ctx.user.id, { ...now, confirmId: confirm.message_id }, SUPPORT_TTL_MS);
});

hubHandlers.callbackQuery("sup:send", async (ctx) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (pending?.kind !== "support" || !pending.messageIds?.length || !pending.chatId) {
    await ctx.answerCallbackQuery({ text: "Не нашёл, что отправлять — напиши ещё раз", show_alert: true });
    return;
  }
  clearPending(ctx.deps, ctx.user.id);
  await ctx.answerCallbackQuery();
  const text = await sendTicket(ctx, pending.chatId, pending.messageIds, !!pending.anon);
  await ctx.editMessageText(text).catch(() => ctx.reply(text));
});

async function sendTicket(ctx: BotContext, chatId: number, messageIds: number[], anon: boolean): Promise<string> {
  const repo = ctx.deps.repo;
  if (repo.supportBlocked(ctx.user.id)) return "Министерство сейчас не принимает от тебя обращения.";
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  if (repo.supportTicketsSince(ctx.user.id, since) >= DAILY_LIMIT[anon ? "anon" : "named"]) {
    return `На сегодня обращений хватит — напиши завтра или напрямую: ${ctx.deps.config.SUPPORT_CONTACT}`;
  }
  const ticket = repo.addSupportTicket(ctx.user.id, anon);
  // Ник — из записи бота: обращение уходит по нажатию «Отправить», а не из самого сообщения.
  const username = ctx.from?.username ?? ctx.user.username;
  const name = ctx.from?.first_name ?? ctx.user.firstName;
  const group = needGroup(ctx);
  const who = anon ? "🕶 анонимно" : `от ${username ? `@${esc(username)}` : esc(name ?? "без имени")}${group ? ` (${esc(group.title)})` : ""} · id <code>${ctx.user.id}</code>`;
  const kb = new InlineKeyboard().text("↩️ Ответить", `supa:r:${ticket}`).text("🚫 Не принимать", `supa:b:${ticket}`);
  let delivered = 0;
  for (const adminId of ctx.deps.config.ADMIN_IDS) {
    try {
      // Кнопки «Ответить / Не принимать» — под заголовком: у copyMessages их нет.
      await ctx.api.sendMessage(adminId, `🏛 <b>Обращение #${ticket}</b> ${who}`, { parse_mode: "HTML", reply_markup: kb });
      // Одним вызовом и по порядку; удалённое человеком сообщение Telegram
      // просто пропустит, а не оборвёт обращение на середине.
      const copied = await ctx.api.copyMessages(adminId, chatId, messageIds);
      if (copied.length) delivered++;
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), ticket }, "support ticket not delivered");
    }
  }
  logger.info({ ticket, anon, delivered }, "support ticket");
  return delivered
    ? `Передал в Министерство Жалоб 🏛 Обращение #${ticket}${anon ? " — анонимно: в обращении нет ни ника, ни id" : ""}. Ответ, если будет, придёт сюда.`
    : `Не получилось передать. Напиши напрямую: ${ctx.deps.config.SUPPORT_CONTACT}`;
}

// ---- ответ админа ----
hubHandlers.callbackQuery(/^supa:(r|b):(\d+)$/, async (ctx) => {
  if (!ctx.isAdmin) return void (await ctx.answerCallbackQuery());
  const ticket = ctx.deps.repo.supportTicket(Number(ctx.match[2]));
  if (!ticket) return void (await ctx.answerCallbackQuery({ text: "Обращение не найдено — человек мог стереть свои данные (/soon)", show_alert: true }));
  if (ctx.match[1] === "b") {
    ctx.deps.repo.blockSupport(ticket.userId);
    await ctx.answerCallbackQuery({ text: "Больше не принимаю обращения от этого отправителя" });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("🚫 Отправитель заблокирован", "noop") }).catch(() => undefined);
    return;
  }
  setPending(ctx.deps, ctx.user.id, { kind: "support-reply", ticket: ticket.id }, SUPPORT_TTL_MS);
  await ctx.answerCallbackQuery();
  await ctx.reply(`Ответ на обращение #${ticket.id}${ticket.anon ? " (анонимное — кто это, не узнаешь)" : ""}: пришли следующим сообщением. Отмена: /cancel`);
});

async function relayReply(ctx: BotContext, ticketId: number): Promise<void> {
  const ticket = ctx.deps.repo.supportTicket(ticketId);
  if (!ticket || !ctx.isAdmin) return void (await ctx.reply("Обращение не найдено."));
  try {
    await ctx.api.sendMessage(ticket.userId, `🏛 <b>Министерство Жалоб</b> отвечает на обращение #${ticket.id}:`, { parse_mode: "HTML" });
    await ctx.api.copyMessage(ticket.userId, ctx.chat!.id, ctx.msg!.message_id);
    logger.info({ ticket: ticket.id }, "support reply");
    await ctx.reply(`Ответ на #${ticket.id} доставлен.`);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200), ticket: ticket.id }, "support reply not delivered");
    await ctx.reply(`Не доставлено: человек, похоже, заблокировал бота.`);
  }
}
