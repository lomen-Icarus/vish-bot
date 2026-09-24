/**
 * Бот в групповых чатах: отвечает, когда к нему обратились — упомянули через
 * @ или ответили на его сообщение. Переписку группы он не читает: в Telegram у
 * ботов по умолчанию включён режим приватности, и такие сообщения до бота
 * просто не доходят.
 *
 * Порядок ответа:
 *   1. база ответов, точное совпадение — сразу, без ИИ и без траты лимита;
 *   2. ИИ в режиме группы: коротко, с той же базой ответов «по смыслу», с
 *      расписанием и справкой по боту, но без поиска людей.
 *
 * Отвечает только в чатах из белого списка: иначе любой мог бы добавить бота
 * к себе и жечь дневной бюджет ИИ. Текст сообщений из групп в базу не пишется,
 * только счётчики для лимитов.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { featuresText, needGroup } from "../views.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { aiLimits } from "../../ai/limits.js";
import { todayMsk } from "../../time.js";
import { logger } from "../../logger.js";

export const groupHandlers = new Composer<BotContext>();

/** Пауза между ответами в одном чате: чтобы бота не раскачали в пинг-понг. */
const COOLDOWN_MS = 8000;
/** Ответов ИИ на один чат в сутки, если админ не задал иного. */
export const GROUP_DEFAULT_LIMIT = 60;

const lastReplyAt = new Map<number, number>();
const inFlight = new Map<number, number>();
/** Чаты, которым сегодня уже сказали «на сегодня всё»: второй раз молчим. */
const limitNoticed = new Set<string>();

export function groupDailyLimit(repo: BotContext["deps"]["repo"]): number {
  const raw = repo.getMeta("group:dailyLimit");
  const v = raw == null || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : GROUP_DEFAULT_LIMIT;
}

/** Нормальная форма для точного совпадения: регистр, «ё», знаки и эмодзи не важны. */
export function normTrigger(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ответ из базы, если сообщение совпало с триггером слово в слово (без учёта знаков). */
export function exactCanned(canned: Array<{ trigger: string; answer: string }>, text: string): string | null {
  const want = normTrigger(text);
  if (!want) return null;
  return canned.find((c) => normTrigger(c.trigger) === want)?.answer ?? null;
}

/**
 * Обращено ли сообщение к боту, и что в нём сказано без самого упоминания.
 * null — сообщение не нам.
 */
export function addressed(ctx: BotContext): { text: string; replyTo: string | null } | null {
  const msg = ctx.message;
  if (!msg?.text || ctx.from?.is_bot) return null;
  // Пересланное сообщение писали не боту: упоминание в нём — чужое, а
  // пересылка спама с @ботом иначе жгла бы лимит ИИ чужими руками.
  if (msg.forward_origin) return null;
  const me = ctx.me;
  const handle = `@${me.username}`.toLowerCase();
  let text = msg.text;
  let mentioned = false;
  for (const e of msg.entities ?? []) {
    const part = msg.text.slice(e.offset, e.offset + e.length);
    if ((e.type === "mention" && part.toLowerCase() === handle) || (e.type === "text_mention" && e.user?.id === me.id)) {
      mentioned = true;
      text = text.replace(part, " ");
    }
  }
  const reply = msg.reply_to_message;
  const toBot = reply?.from?.id === me.id;
  if (!mentioned && !toBot) return null;
  // Вопрос «а это как?» в ответ на чужое сообщение без этого сообщения непонятен.
  const replyTo = reply && !toBot ? (reply.text ?? reply.caption ?? null) : null;
  return { text: text.replace(/\s+/g, " ").trim(), replyTo };
}

function isGroup(ctx: BotContext): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

async function replyIn(ctx: BotContext, text: string): Promise<void> {
  const html = clampHtml(text, 3500);
  const opts = { reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } };
  await ctx.reply(html, { ...opts, parse_mode: "HTML" }).catch(() => ctx.reply(html.replace(/<[^>]+>/g, ""), opts));
}

// ---- включение и выключение прямо в чате ----

groupHandlers.chatType(["group", "supergroup"]).command("chaton", async (ctx) => {
  if (!ctx.isAdmin) return;
  ctx.deps.repo.enableGroupChat(ctx.chat.id, ctx.chat.title ?? null, ctx.from?.id ?? null);
  await ctx.reply(`Привет! Теперь я здесь отвечаю, если меня позвать: <code>@${ctx.me.username} что завтра у 12-23</code> или просто ответом на моё сообщение.`, { parse_mode: "HTML" });
});

groupHandlers.chatType(["group", "supergroup"]).command("chatoff", async (ctx) => {
  if (!ctx.isAdmin) return;
  ctx.deps.repo.disableGroupChat(ctx.chat.id);
  await ctx.reply("Ок, в этом чате молчу. Включить обратно: /chaton");
});

// ---- бота добавили в чат ----

groupHandlers.on("my_chat_member", async (ctx) => {
  const chat = ctx.myChatMember.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const status = ctx.myChatMember.new_chat_member.status;
  const repo = ctx.deps.repo;
  const title = chat.title ?? null;
  // Бота выгнали — список в /chats должен это показывать, а не врать «включён».
  if (status === "left" || status === "kicked") {
    repo.disableGroupChat(chat.id);
    return;
  }
  if (status !== "member" && status !== "administrator") return;
  // Админ добавил бота сам — значит, хочет, чтобы тот работал: включаем сразу.
  if (ctx.isAdmin) {
    repo.enableGroupChat(chat.id, title, ctx.from?.id ?? null);
    await ctx.api.sendMessage(chat.id, `Привет! Зовите меня <code>@${ctx.me.username}</code> — отвечу про пары, преподавателей и вообще.`, { parse_mode: "HTML" }).catch(() => undefined);
    return;
  }
  if (repo.groupChatEnabled(chat.id)) return;
  repo.rememberGroupChat(chat.id, title);
  // Кто-то другой: бот молчит, а админу приходит вопрос с кнопкой.
  const who = ctx.from ? (ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name) : "кто-то";
  const kb = new InlineKeyboard().text("✅ Разрешить отвечать", `gch:on:${chat.id}`);
  for (const adminId of ctx.deps.config.ADMIN_IDS) {
    await ctx.api
      .sendMessage(adminId, `👥 Меня добавили в чат «${esc(title ?? String(chat.id))}» (${esc(who)}). Пока я там молчу.`, { parse_mode: "HTML", reply_markup: kb })
      .catch((err) => logger.debug({ err: String(err), adminId }, "group join notice failed"));
  }
});

// ---- обращение к боту ----

groupHandlers.on("message:text", async (ctx, next) => {
  if (!isGroup(ctx)) return next();
  const msg = addressed(ctx);
  if (!msg) return next();
  const chatId = ctx.chat!.id;
  const repo = ctx.deps.repo;
  if (!repo.groupChatEnabled(chatId)) return;
  if (Date.now() - (lastReplyAt.get(chatId) ?? 0) < COOLDOWN_MS) return;

  const canned = repo.cannedReplies();
  const instant = exactCanned(canned, msg.text);
  if (instant) {
    lastReplyAt.set(chatId, Date.now());
    return void (await replyIn(ctx, esc(instant)));
  }
  if (!msg.text) {
    lastReplyAt.set(chatId, Date.now());
    return void (await replyIn(ctx, `Я тут 👋 Спроси, например: <code>@${ctx.me.username} что завтра у 12-23</code>`));
  }
  const ask = ctx.deps.ask;
  if (!ask) return;

  const day = todayMsk();
  const key = `${chatId}:${day}`;
  const limit = groupDailyLimit(repo);
  // Лимит 0 — админ оставил в группах только базу ответов: ИИ молчит без объявлений.
  if (limit === 0) return;
  const used = repo.aiUsage(chatId, day) + (inFlight.get(chatId) ?? 0);
  const overChat = used >= limit;
  const overGlobal = repo.aiUsageGlobal(day) >= aiLimits(repo, ctx.deps.config, day).global;
  if (overChat || overGlobal) {
    if (limitNoticed.has(key)) return;
    limitNoticed.add(key);
    return void (await replyIn(ctx, overChat ? "На сегодня я в этом чате выговорился 🫠 Завтра продолжим. Расписание всегда есть в личке." : "Сегодня бот уже много отвечал, общий бюджет закончился. Завтра продолжим."));
  }

  lastReplyAt.set(chatId, Date.now());
  inFlight.set(chatId, (inFlight.get(chatId) ?? 0) + 1);
  try {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const res = await ask.answer({
      question: msg.text,
      group: needGroup(ctx),
      subgroup: ctx.user.subgroup,
      userId: ctx.user.id,
      botHelp: featuresText(ctx.deps),
      mode: "group",
      canned,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    // Счётчик ведётся на чат, а не на человека: личный лимит в боте — для
    // лички, и болтовня в группе его съедать не должна. В общий бюджет дня
    // ответы группы входят как обычно.
    repo.bumpAiUsage(chatId, day, res.inputTokens, res.outputTokens);
    await replyIn(ctx, res.text);
  } catch (err) {
    logger.warn({ err: String(err), chatId }, "group answer failed");
  } finally {
    const left = (inFlight.get(chatId) ?? 1) - 1;
    if (left > 0) inFlight.set(chatId, left);
    else inFlight.delete(chatId);
  }
});

/** Для тестов: сбросить паузы и отметки «лимит показан». */
export function resetGroupState(): void {
  lastReplyAt.clear();
  inFlight.clear();
  limitNoticed.clear();
}
