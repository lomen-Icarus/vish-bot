/**
 * Болталка в групповых чатах: «@бот привет» или ответ на сообщение бота — и
 * он отвечает через Claude с учётом разговора (src/chat/service.ts).
 *
 * Где болтать, решает админ бота: чат, куда бота добавил сам админ, включается
 * сразу; добавил кто-то другой — админам приходит вопрос с кнопкой
 * «Разрешить». Ещё: «/admin → 💬 Болталка», CHAT_GROUP_IDS или /chaton и
 * /chatoff прямо в чате.
 * Лимиты на день — там же. Всё остальное в группах работает как раньше:
 * команды получают подсказку «пиши в личку», inline — как был.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import type { BotContext, Deps } from "../context.js";
import { chatAllowance, type ChatVerdict } from "../../chat/limits.js";
import { featuresText, needGroup } from "../views.js";
import { esc } from "../../schedule/format.js";
import { todayMsk, wallClock } from "../../time.js";
import { logger } from "../../logger.js";

export const groupChatHandlers = new Composer<BotContext>();

const isGroup = (type: string | undefined): boolean => type === "group" || type === "supergroup";

/** Можно ли боту болтать в этом чате. */
export function chatEnabled(deps: Deps, chatId: number): boolean {
  return deps.config.CHAT_GROUP_IDS.includes(chatId) || deps.repo.chatGroup(chatId)?.enabled === true;
}

/** Метка «админ выключил болталку в этом чате сам»: такой чат не оживает от упоминания админом. */
const chatOffKey = (chatId: number): string => `chat:off:${chatId}`;

/** Явно включить или выключить болталку в чате (команды, кнопки админки). */
export function switchChat(deps: Deps, chatId: number, on: boolean, patch: { title?: string | null; present?: boolean } = {}): void {
  deps.repo.upsertChatGroup(chatId, { ...patch, enabled: on });
  deps.repo.setMeta(chatOffKey(chatId), on ? "" : "1");
}

/** Обращаются ли к боту: @упоминание (в тексте или подписи) или ответ на его сообщение. */
export function addressedToBot(msg: Message, me: UserFromGetMe): boolean {
  // Пересланное сообщение писали не боту: упоминание в нём чужое, а пересылка
  // спама с @ботом иначе жгла бы лимит чужими руками.
  if (msg.forward_origin) return false;
  const reply = msg.reply_to_message;
  // Ответ на сообщение, вставленное через inline, — ответ человеку, а не боту.
  if (reply?.from?.id === me.id && !reply.via_bot) return true;
  const text = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const handle = me.username ? `@${me.username.toLowerCase()}` : null;
  return entities.some((e) => (e.type === "mention" && handle !== null && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle) || (e.type === "text_mention" && e.user.id === me.id));
}

/** Текст реплики без упоминания бота и знаков-обращений в начале. */
export function stripMention(text: string, username: string | undefined): string {
  const cleaned = username ? text.replace(new RegExp(`@${username}(?![A-Za-z0-9_])`, "gi"), " ") : text;
  return cleaned.replace(/^[\s,.:;!—–-]+/, "").replace(/\s+/g, " ").trim();
}

function speakerName(msg: Message): string {
  return (msg.from?.first_name || msg.sender_chat?.title || "кто-то").slice(0, 40);
}

/** Пауза между ответами в одном чате: чтобы бота не раскачали в пинг-понг. */
export const CHAT_COOLDOWN_MS = 3000;

// ---- состояние процесса ----
const lastReplyAt = new Map<number, number>();
/** Кому бот отвечает прямо сейчас: второй вопрос того же человека ждёт, а не идёт параллельно. */
const busy = new Set<number>();
const inFlightByChat = new Map<number, number>();
let inFlightGlobal = 0;
/** О лимите говорим один раз за день на человека/чат — иначе бот спамит отказами. */
const limitNoticed = new Set<string>();
/** «Здесь я не болтаю» — один раз на чат за время работы процесса. */
const disabledNoticed = new Set<number>();
/** Сбои модели не пересказываем чаще раза в 10 минут на чат. */
const errorNoticedAt = new Map<number, number>();

/** Для тестов: забыть паузы между ответами (остальную память не трогать). */
export function resetChatCooldowns(): void {
  lastReplyAt.clear();
}

/** Для тестов: сбросить память процесса. */
export function resetGroupChatState(): void {
  lastReplyAt.clear();
  busy.clear();
  inFlightByChat.clear();
  inFlightGlobal = 0;
  limitNoticed.clear();
  disabledNoticed.clear();
  errorNoticedAt.clear();
}

function limitText(verdict: ChatVerdict): string {
  if (verdict === "limit-user") return "На сегодня я с тобой наговорился 🙂 Завтра продолжим.";
  if (verdict === "limit-chat") return "В этом чате я на сегодня всё, язык устал 🙂 До завтра.";
  return "Я сегодня уже со всеми наболтался — лимит на день кончился. До завтра 🙂";
}

// Включить или выключить болталку прямо в чате — только админ бота.
groupChatHandlers.chatType(["group", "supergroup"]).command(["chaton", "chatoff"], async (ctx) => {
  if (!ctx.isAdmin) return;
  const on = ctx.msg.text.startsWith("/chaton");
  switchChat(ctx.deps, ctx.chat.id, on, { title: ctx.chat.title ?? null, present: true });
  // Чат из CHAT_GROUP_IDS включён в .env: отсюда его не выключить, и обещать «молчу» нельзя.
  if (!on && ctx.deps.config.CHAT_GROUP_IDS.includes(ctx.chat.id)) return void (await ctx.reply("Этот чат включён в настройках бота (CHAT_GROUP_IDS в .env) — выключить его можно только там."));
  if (!on) return void (await ctx.reply("Ок, в этом чате молчу. Включить обратно: /chaton"));
  if (!ctx.deps.chat) return void (await ctx.reply("Чат включён, но болталка выключена в настройках бота (CHAT_AI=FALSE или нет ключа Anthropic)."));
  await ctx.reply(`Привет! Теперь я здесь отвечаю, если меня позвать: «@${ctx.me.username} …» или ответом на моё сообщение.`);
});

// Бота добавили в группу или удалили из неё.
groupChatHandlers.on("my_chat_member", async (ctx, next) => {
  const chat = ctx.chat;
  if (!isGroup(chat.type)) return next();
  const deps = ctx.deps;
  const m = ctx.myChatMember.new_chat_member;
  const present = m.status === "member" || m.status === "administrator" || (m.status === "restricted" && m.is_member);
  const title = "title" in chat ? (chat.title ?? null) : null;
  const cur = deps.repo.chatGroup(chat.id);
  if (!present) {
    deps.repo.upsertChatGroup(chat.id, { title, present: false, enabled: false });
    logger.info({ chat: chat.id }, "group chat: bot removed");
    return;
  }
  // Добавил админ бота — значит, болтать тут можно. Повышение до админа и
  // прочие смены статуса включённость не трогают: иначе /chatoff отменялся
  // бы, стоило админу бота поменять боту права.
  const byAdmin = deps.config.ADMIN_IDS.includes(ctx.from.id);
  const wasPresent = cur?.present === true;
  const enabled = wasPresent ? cur.enabled : byAdmin;
  if (!wasPresent && byAdmin) switchChat(deps, chat.id, true, { title, present: true });
  else deps.repo.upsertChatGroup(chat.id, { title, present: true, enabled });
  logger.info({ chat: chat.id, enabled, byAdmin }, "group chat: bot added");
  if (wasPresent) return;
  if (enabled || chatEnabled(deps, chat.id)) {
    if (!deps.chat) return;
    const me = ctx.me;
    await ctx.reply(`Привет! Зовите: «@${me.username} …» или отвечайте на мои сообщения — поболтаю, подскажу про пары и преподавателей.`).catch(() => undefined);
    return;
  }
  // Добавил кто-то другой: бот молчит, а админам приходит вопрос с кнопкой.
  if (!deps.chat) return;
  const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const kb = new InlineKeyboard().text("✅ Разрешить болтать", `gch:on:${chat.id}`);
  for (const adminId of deps.config.ADMIN_IDS) {
    await ctx.api
      .sendMessage(adminId, `👥 Меня добавили в чат «${esc(title ?? String(chat.id))}» (${esc(who)}). Пока я там молчу.`, { parse_mode: "HTML", reply_markup: kb })
      .catch((err: unknown) => logger.debug({ err: String(err), adminId }, "group join notice failed"));
  }
});

groupChatHandlers.on("message", async (ctx, next) => {
  const deps = ctx.deps;
  const service = deps.chat;
  if (!service || !isGroup(ctx.chat.type) || !ctx.from) return next();
  const msg = ctx.msg;
  const chatId = ctx.chat.id;
  const me = ctx.me;
  const raw = msg.text ?? msg.caption ?? "";
  const isCommand = raw.startsWith("/");
  const addressed = !isCommand && addressedToBot(msg, me);
  let enabled = chatEnabled(deps, chatId);
  const title = "title" in ctx.chat ? (ctx.chat.title ?? null) : null;

  if (!addressed) {
    // Переписку бот запоминает только там, где ему разрешено болтать.
    if (enabled && raw && !isCommand) service.memory.push(chatId, { at: Date.now(), userId: ctx.from.id, name: speakerName(msg), text: raw });
    return next();
  }

  if (!enabled) {
    const known = deps.repo.chatGroup(chatId);
    // Бот стоял в чате ещё до болталки: админ бота позвал его — включаем. Но
    // выключенный админом сам (/chatoff, кнопка) чат от упоминания не оживает.
    if (ctx.isAdmin && !deps.repo.getMeta(chatOffKey(chatId))) {
      deps.repo.upsertChatGroup(chatId, { title, present: true, enabled: true });
      enabled = true;
    } else {
      if (!known || known.title !== title) deps.repo.upsertChatGroup(chatId, { title, present: true });
      if (!disabledNoticed.has(chatId)) {
        disabledNoticed.add(chatId);
        await ctx.reply(`Болтать в этом чате меня пока не включили. Расписание — inline: «@${me.username} 12-23 завтра» или в личке.`, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => undefined);
      }
      return;
    }
  }

  const known = deps.repo.chatGroup(chatId);
  if (known && known.title !== title) deps.repo.upsertChatGroup(chatId, { title });

  const userId = ctx.from.id;
  const speaker = speakerName(msg);
  const text = stripMention(raw, me.username);
  // Контекст — до того, как текущая реплика попадёт в память.
  const transcript = service.memory.recent(chatId);
  // Бот ещё отвечает этому человеку на прошлое — новую реплику не отвечаем, но
  // и не теряем: в память она идёт как обычная, чтобы следующий ответ её видел
  // (обращённые реплики берутся из журнала, а этой в журнале не будет).
  if (busy.has(userId)) {
    service.memory.push(chatId, { at: Date.now(), userId, name: speaker, text: text || raw });
    return;
  }
  service.memory.push(chatId, { at: Date.now(), userId, name: speaker, text: text || raw, addressed: true });
  if (Date.now() - (lastReplyAt.get(chatId) ?? 0) < CHAT_COOLDOWN_MS) return;
  const day = todayMsk();
  const { verdict } = chatAllowance(deps.repo, deps.config, { userId, chatId, isAdmin: ctx.isAdmin }, day, { chat: inFlightByChat.get(chatId) ?? 0, global: inFlightGlobal });
  if (verdict !== "ok") {
    const key = `${day}:${verdict}:${verdict === "limit-user" ? userId : chatId}`;
    // Ключи со вчерашней датой больше не нужны: не даём множеству расти вечно.
    if (limitNoticed.size > 5000) limitNoticed.clear();
    if (!limitNoticed.has(key)) {
      limitNoticed.add(key);
      await ctx.reply(limitText(verdict), { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => undefined);
    }
    return;
  }

  const reply = msg.reply_to_message;
  const repliedTo =
    reply && reply.from?.id !== me.id && (reply.text || reply.caption)
      ? { name: (reply.from?.first_name || reply.sender_chat?.title || "кого-то").slice(0, 40), text: (reply.text ?? reply.caption ?? "").slice(0, 600) }
      : null;

  busy.add(userId);
  lastReplyAt.set(chatId, Date.now());
  inFlightByChat.set(chatId, (inFlightByChat.get(chatId) ?? 0) + 1);
  inFlightGlobal++;
  try {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const history = deps.repo.recentChat(chatId, userId, 6 * 60 * 60_000, 6).map((h) => ({ question: h.question, answer: h.answer }));
    const now = wallClock();
    // Своя группа человека — если он пользуется ботом в личке: «что у меня завтра».
    const group = needGroup(ctx);
    const tools = deps.ask?.groupTools({ group, subgroup: ctx.user.subgroup, userId, botHelp: featuresText(deps) });
    const result = await service.reply({ chatTitle: title, speaker, speakerId: userId, text, history, transcript, repliedTo, now: { date: now.date, minutes: now.minutes }, speakerGroup: group?.title ?? null, ...(tools ? { tools } : {}) });
    const answer = result.refused ? "На это отвечать не буду 🙂" : result.text || "Хм, даже не знаю, что сказать 🙂";
    deps.repo.bumpChatUsage(chatId, userId, day, result.inputTokens, result.outputTokens);
    await ctx.reply(answer, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    deps.repo.logChat(chatId, userId, text || "(позвал без текста)", answer);
    service.memory.push(chatId, { at: Date.now(), userId: null, name: me.first_name, text: answer, toUserId: userId });
    // Ни имён, ни текста в логах: только цифры.
    logger.info({ chat: chatId, matched: result.matched, input: result.inputTokens, output: result.outputTokens, refused: result.refused }, "group chat: replied");
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 300), chat: chatId }, "group chat: reply failed");
    const last = errorNoticedAt.get(chatId) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      errorNoticedAt.set(chatId, Date.now());
      await ctx.reply("Что-то я задумался и потерял мысль. Спроси ещё раз чуть позже 🙂", { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => undefined);
    }
  } finally {
    busy.delete(userId);
    inFlightByChat.set(chatId, Math.max(0, (inFlightByChat.get(chatId) ?? 1) - 1));
    inFlightGlobal = Math.max(0, inFlightGlobal - 1);
  }
});
