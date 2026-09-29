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
 *
 * «Социальность» (src/bot/social.ts, src/chat/social.ts): войдя в чат, бот
 * спрашивает «а что это за группа?» и запоминает ответ; знакомится
 * («@ник это Фамилия Имя 12-23»); подписывает тему чата на слайды вебинаров;
 * ночью, если его долго не трогали, сначала сонно ворчит.
 */
import { Composer, InlineKeyboard, InputFile, type Api } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BotContext, Deps } from "../context.js";
import { chatAllowance, type ChatVerdict } from "../../chat/limits.js";
import { featuresText, needGroup } from "../views.js";
import { esc, plural } from "../../schedule/format.js";
import { fmtDDMM, todayMsk, wallClock, type WallClock } from "../../time.js";
import { deckFileName } from "../../notify/deckName.js";
import { logger } from "../../logger.js";
import type { ChatTool } from "../../chat/service.js";
import type { QaMedia } from "../../chat/qa.js";
import { featureReply, isNight, parseIntro, parseSlidesRequest, REFUSAL_PHRASE, SLEEPY_IDLE_MS, sleepyLine } from "../../chat/social.js";
import { confirmSlideSub, forgetIntro, handleIntro, handleSlidesRequest, introGroup, introTargets, introTool, knownFirstName, slidesTool, type DeckToSend, type SlidesReply, type SlidesToolState } from "../social.js";

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

/** Первое, что бот пишет в новом чате; ответ на это сообщение — описание чата. */
export const ABOUT_QUESTION = "Привет, а что это за группа?";
const aboutAskKey = (chatId: number): string => `chat:about-ask:${chatId}`;
const aboutKey = (chatId: number): string => `chat:about:${chatId}`;
const adderKey = (chatId: number): string => `chat:adder:${chatId}`;
/** Длиннее описание чата не бывает: это уже простыня в каждом запросе к модели. */
const ABOUT_MAX = 1500;

/** Что это за чат — со слов участников; null — ещё не рассказали. */
export function chatAbout(deps: Deps, chatId: number): string | null {
  return deps.repo.getMeta(aboutKey(chatId)) || null;
}

/** Спросить в чате «а что это за группа?» и запомнить, на какое сообщение ждать ответ. */
export async function askAboutChat(api: Api, deps: Deps, chatId: number): Promise<void> {
  const sent = await api.sendMessage(chatId, ABOUT_QUESTION).catch((err: unknown) => {
    logger.debug({ err: String(err), chat: chatId }, "group chat: about question failed");
    return null;
  });
  if (sent) deps.repo.setMeta(aboutAskKey(chatId), String(sent.message_id));
}

/** Рассказать боту о чате может его админ, админ чата или тот, кто бота добавил. */
async function mayDescribeChat(ctx: BotContext): Promise<boolean> {
  const from = ctx.from;
  if (!from || !ctx.chat) return false;
  if (ctx.isAdmin || ctx.deps.repo.getMeta(adderKey(ctx.chat.id)) === String(from.id)) return true;
  try {
    const m = await ctx.getChatMember(from.id);
    return m.status === "creator" || m.status === "administrator";
  } catch {
    return false;
  }
}

/** Часы и случай — отдельно, чтобы тесты не зависели от того, ночь ли сейчас. */
export const chatClock: { now: () => WallClock; random: (n: number) => number } = { now: () => wallClock(), random: (n) => randomInt(n) };

/**
 * «Это не я», «не зови меня так» — стереть знакомство про себя. Только вся
 * реплика целиком: «не я ли вчера спрашивал…» или «забудь меня разбудить»
 * знакомство стирать не должны.
 */
export const NOT_ME = /^(?:(?:это|нет,?)\s+)?не\s+я[.!)\s]*$|^не\s+зови\s+меня(?:\s+(?:так|по\s+имени))?[.!)\s]*$|^забудь\s+(?:меня|моё\s+имя|мое\s+имя)[.!)\s]*$/iu;

/** Сколько идей в сутки от одного человека доходит до админов; остальные только пишутся в базу. */
const IDEAS_NOTIFY_PER_DAY = 5;

// ---- состояние процесса ----
const lastReplyAt = new Map<number, number>();
/** Когда к боту в чате последний раз обращались: для «разбудили ночью». */
const lastTouchAt = new Map<number, number>();
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
  lastTouchAt.clear();
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

// Переспросить «а что это за группа?» — админ бота или админ чата.
groupChatHandlers.chatType(["group", "supergroup"]).command("chatabout", async (ctx) => {
  if (!ctx.deps.chat || !chatEnabled(ctx.deps, ctx.chat.id) || !(await mayDescribeChat(ctx))) return;
  await askAboutChat(ctx.api, ctx.deps, ctx.chat.id);
});

// Кнопка под вопросом «Ты хочешь получать слайды …?».
groupChatHandlers.callbackQuery(/^css:([0-9a-f]{8}):(\d|n)$/, async (ctx) => {
  await confirmSlideSub(ctx, ctx.match[1]!, ctx.match[2]!);
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
  // Кто добавил — тот может рассказать, что это за чат.
  deps.repo.setMeta(adderKey(chat.id), String(ctx.from.id));
  if (enabled || chatEnabled(deps, chat.id)) {
    if (!deps.chat) return;
    await askAboutChat(ctx.api, deps, chat.id);
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
    if (enabled && raw && !isCommand) {
      service.memory.push(chatId, { at: Date.now(), userId: ctx.from.id, name: speakerName(msg), text: raw });
      // «@ник это Фамилия Имя 12-23» — знакомят и без обращения к боту. Но не
      // пересылкой: её писали не здесь и не боту.
      const intro = msg.forward_origin ? null : parseIntro(raw, msg.entities ?? msg.caption_entities ?? [], me.username, me.id, ctx.from, false);
      const answer = intro && Date.now() - (lastReplyAt.get(chatId) ?? 0) >= CHAT_COOLDOWN_MS ? handleIntro(deps, intro, ctx.from, chatId, false) : null;
      if (answer) {
        lastReplyAt.set(chatId, Date.now());
        await ctx.reply(answer, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => undefined);
        service.memory.push(chatId, { at: Date.now(), userId: null, name: me.first_name, text: answer, toUserId: ctx.from.id });
        return;
      }
    }
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
  // «Не трогали 30+ минут» считается от прошлого обращения, а после перезапуска — по журналу.
  const idleSince = lastTouchAt.get(chatId) ?? deps.repo.lastChatAt(chatId) ?? 0;
  lastTouchAt.set(chatId, Date.now());
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
  // Своя группа человека — если он пользуется ботом в личке или его представили в чате.
  const group = needGroup(ctx) ?? introGroup(deps, ctx.from, ctx.user);

  // Ответы без модели: описание чата, слайды в тему, знакомство. Лимиты ИИ они не тратят.
  const quick = await quickReply(ctx, raw, text, group);
  if (quick) {
    lastReplyAt.set(chatId, Date.now());
    if (quick.media) await sendMedia(ctx, quick.media, quick.text);
    else await ctx.reply(quick.text, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, ...(quick.kb ? { reply_markup: quick.kb } : {}) }).catch((err: unknown) => logger.warn({ err: String(err).slice(0, 200), chat: chatId }, "group chat: quick reply failed"));
    if (quick.deck) await sendDeck(ctx, quick.deck);
    const logged = quick.text || `[${quick.media?.kind ?? "media"}]`;
    deps.repo.logChat(chatId, userId, text || raw, logged);
    service.memory.push(chatId, { at: Date.now(), userId: null, name: me.first_name, text: logged, toUserId: userId });
    return;
  }

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
    const now = chatClock.now();
    // Ночь, и в чате бота полчаса не трогали: сначала сонно ворчит, потом отвечает.
    const sleepy = isNight(now.minutes) && Date.now() - idleSince >= SLEEPY_IDLE_MS;
    if (sleepy) await ctx.reply(sleepyLine(chatClock.random)).catch(() => undefined);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const history = deps.repo.recentChat(chatId, userId, 6 * 60 * 60_000, 6).map((h) => ({ question: h.question, answer: h.answer }));
    // Слайды: модель зовёт chat_slides, а кнопки или PDF бот прикладывает к её ответу сам.
    const slides: SlidesToolState = {};
    const tools: ChatTool[] = [
      ...(deps.ask?.groupTools({ group, subgroup: needGroup(ctx) ? ctx.user.subgroup : null, userId, botHelp: featuresText(deps) }) ?? []),
      ideaTool(ctx, title),
      slidesTool(ctx, group, slides),
      // Знакомство в свободной форме: «знакомься, это Фамилия Имя — @ник».
      introTool(ctx, introTargets(msg, me)),
    ];
    const result = await service.reply({
      chatTitle: title,
      speaker,
      speakerId: userId,
      text,
      history,
      transcript,
      repliedTo,
      now: { date: now.date, minutes: now.minutes },
      speakerGroup: group?.title ?? null,
      speakerRealName: knownFirstName(deps, ctx.from, ctx.user),
      chatAbout: chatAbout(deps, chatId),
      sleepy,
      tools,
    });
    const answer = result.refused ? REFUSAL_PHRASE : result.text || "Хм, даже не знаю, что сказать 🙂";
    deps.repo.bumpChatUsage(chatId, userId, day, result.inputTokens, result.outputTokens);
    // Заготовка-гифка: её шлёт бот, ответ модели — подпись. Только при точном
    // совпадении вопроса (похожий вопрос — ещё не повод для гифки) и не когда
    // к ответу нужны кнопки слайдов: у гифки-ответа их не будет.
    const kb = result.refused ? undefined : slides.kb;
    const media = !result.refused && !kb && result.top?.how === "exact" && result.top.entry.media ? result.top.entry.media : null;
    if (media) await sendMedia(ctx, media, answer);
    else await ctx.reply(answer, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, ...(kb ? { reply_markup: kb } : {}) });
    if (slides.deck && !result.refused) await sendDeck(ctx, slides.deck);
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

/**
 * Ответ без модели, если реплика — одно из «социальных» действий:
 *  1) ответ на «а что это за группа?» от того, кто может описать чат;
 *  2) слайды вебинаров в эту тему: подписка, отписка, список;
 *  3) знакомство «@ник это Фамилия Имя 12-23» или «я — …».
 */
type QuickReply = SlidesReply & { media?: QaMedia };

async function quickReply(ctx: BotContext, raw: string, text: string, group: ReturnType<typeof needGroup>): Promise<QuickReply | null> {
  const deps = ctx.deps;
  const msg = ctx.msg!;
  const chatId = ctx.chat!.id;
  // Заготовка — одна гифка без текста, и реплика совпала с вопросом дословно:
  // модели тут нечего писать, шлём гифку сразу, лимит не тратим. Похожая
  // реплика («привет, а где пара?» к гифке на «привет») идёт к модели.
  const top = deps.chat?.qa.match(text, 1)[0];
  if (top && top.how === "exact" && top.entry.media && !top.entry.answer) return { text: "", media: top.entry.media };
  const reply = msg.reply_to_message;
  const askId = deps.repo.getMeta(aboutAskKey(chatId));
  if (askId && reply?.from?.id === ctx.me.id && String(reply.message_id) === askId && (text || raw).trim() && (await mayDescribeChat(ctx))) {
    deps.repo.setMeta(aboutKey(chatId), (text || raw).trim().slice(0, ABOUT_MAX));
    logger.info({ chat: chatId }, "group chat: about saved");
    return { text: "Понял, запомнил 🙂 Зовите: «@" + (ctx.me.username ?? "бот") + " …» или отвечайте на мои сообщения." };
  }
  const slides = parseSlidesRequest(text);
  if (slides) return handleSlidesRequest(ctx, slides, group);
  // «@бот это не я» — человек не хочет, чтобы его знали по чужому знакомству.
  if (NOT_ME.test(text)) return { text: forgetIntro(deps, ctx.from!) ? "Ок, забыл 🙂" : "А я тебя и не записывал 🙂" };
  const intro = parseIntro(raw, msg.entities ?? msg.caption_entities ?? [], ctx.me.username, ctx.me.id, ctx.from!, true);
  const introAnswer = intro ? handleIntro(deps, intro, ctx.from!, chatId, true) : null;
  if (introAnswer) return { text: introAnswer };
  return null;
}

/** Гифка, стикер или картинка из сценария — ответом на реплику; подпись — текст модели. */
async function sendMedia(ctx: BotContext, media: QaMedia, caption: string): Promise<void> {
  const msg = ctx.msg!;
  const reply = { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
  // Подпись у Telegram — до 1024 символов; у стикера подписи нет вовсе.
  const text = caption.trim().slice(0, 1000);
  try {
    if (media.kind === "gif") await ctx.replyWithAnimation(media.fileId, { ...reply, ...(text ? { caption: text } : {}) });
    else if (media.kind === "photo") await ctx.replyWithPhoto(media.fileId, { ...reply, ...(text ? { caption: text } : {}) });
    else {
      await ctx.replyWithSticker(media.fileId, reply);
      if (text) await ctx.reply(text).catch(() => undefined);
    }
  } catch (err) {
    // file_id умер (сменили токен бота) или гифку удалили — отвечаем хотя бы текстом.
    logger.warn({ err: String(err).slice(0, 200), kind: media.kind }, "group chat: media reply failed");
    await ctx.reply(text || "Тут должна была быть гифка, но она потерялась 😔", reply).catch(() => undefined);
  }
}

/**
 * Прислать готовый PDF в чат (в ту же тему): по file_id, если он уже уходил
 * в Telegram, иначе файлом с диска — и запомнить file_id на будущее.
 */
async function sendDeck(ctx: BotContext, deck: DeckToSend): Promise<void> {
  let doc: string | InputFile;
  try {
    doc = deck.fileId ?? new InputFile(readFileSync(deck.file), deckFileName(deck));
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200), deck: deck.id }, "group chat: deck file unreadable");
    await ctx.reply("Файл этой записи у меня потерялся 😔").catch(() => undefined);
    return;
  }
  try {
    const sent = await ctx.replyWithDocument(doc, { caption: `📎 ${deck.subject} · ${fmtDDMM(deck.date)} · ${deck.slides} ${plural(deck.slides, "слайд", "слайда", "слайдов")}` });
    // Только file_id: отметку «разослано» и число получателей ставит рассылка.
    if (!deck.fileId && sent.document?.file_id) ctx.deps.repo.setDeckFileId(deck.id, sent.document.file_id);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200), deck: deck.id }, "group chat: deck send failed");
    await ctx.reply("Не смог отправить файл, попробуй позже 🙂").catch(() => undefined);
  }
}

/** Инструмент «записать идею»: модель зовёт его, когда боту предлагают новую функцию. */
function ideaTool(ctx: BotContext, chatTitle: string | null): ChatTool {
  const deps = ctx.deps;
  const from = ctx.from!;
  const chatId = ctx.chat!.id;
  return {
    name: "suggest_feature",
    description: "Записать идею новой функции для бота, которую предложил человек в чате («добавь…», «сделай, чтобы бот…»). Идея уходит владельцу бота.",
    input_schema: { type: "object", properties: { idea: { type: "string", description: "Суть идеи одной-двумя фразами" } }, required: ["idea"] },
    parse: (input: unknown) => {
      const idea = String((input as { idea?: unknown } | null)?.idea ?? "").trim();
      if (!idea) throw new Error("пустая идея");
      return { idea: idea.slice(0, 1000) };
    },
    run: async ({ idea }: { idea: string }) => {
      const perDay = deps.repo.ideasSince(new Date(Date.now() - 86_400_000).toISOString(), from.id);
      deps.repo.addIdea(chatId, from.id, idea);
      if (perDay < IDEAS_NOTIFY_PER_DAY) {
        const who = from.username ? `@${from.username}` : from.first_name;
        // Админам — в фоне: ответ в чате не должен ждать доставки в личку.
        void (async () => {
          for (const adminId of deps.config.ADMIN_IDS) {
            await ctx.api
              .sendMessage(adminId, `💡 <b>Идея для бота</b> из чата «${esc(chatTitle ?? String(chatId))}» от ${esc(who)}:\n${esc(idea)}\n\nВсе идеи: /ideas`, { parse_mode: "HTML" })
              .catch((err: unknown) => logger.debug({ err: String(err), adminId }, "idea notice failed"));
          }
        })();
      }
      return `Записал. Ответь ровно: «${featureReply(deps.config.OWNER_USERNAME ?? null)}»`;
    },
  };
}
