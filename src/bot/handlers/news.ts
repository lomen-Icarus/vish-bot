/**
 * News relay: posts in configured channels/chats are copied to users who
 * subscribed to the matching topic. Routing is by hashtag (see TOPIC_HASHTAGS);
 * "#всем" goes to everyone. Posts without a recognised tag are ignored.
 */
import { Composer } from "grammy";
import type { BotContext, Deps } from "../context.js";
import { TOPIC_HASHTAGS, TOPICS, type Topic } from "../keyboards.js";
import { logger } from "../../logger.js";
import { sleep } from "../../time.js";
import type { User } from "../../db/repo.js";
import { isUnreachable } from "../errors.js";

export const newsHandlers = new Composer<BotContext>();

export function topicsForText(text: string): Topic[] | "all" {
  if (/#(всем|all)(?=$|[^\p{L}\p{N}_])/iu.test(text)) return "all";
  return TOPICS.filter((t) => TOPIC_HASHTAGS[t].test(text));
}

async function relay(deps: Deps, api: BotContext["api"], fromChatId: number, messageId: number, text: string): Promise<void> {
  const topics = topicsForText(text);
  let recipients: User[];
  if (topics === "all") recipients = deps.repo.listUsers({ onlyActive: true });
  else {
    const seen = new Map<number, User>();
    for (const t of topics) for (const u of deps.repo.usersForTopic(t)) seen.set(u.id, u);
    recipients = [...seen.values()];
  }
  if (topics !== "all" && topics.length === 0) {
    logger.info({ fromChatId, messageId }, "news post without a topic hashtag, skipped");
    return;
  }
  let ok = 0;
  for (const u of recipients) {
    try {
      await api.copyMessage(u.id, fromChatId, messageId);
      ok++;
    } catch (err) {
      if (isUnreachable(err)) deps.repo.updateUser(u.id, { blocked: true });
    }
    await sleep(40);
  }
  logger.info({ fromChatId, messageId, topics, delivered: ok, total: recipients.length }, "news relayed");
}

newsHandlers.on("channel_post", async (ctx) => {
  const deps = ctx.deps;
  if (!deps.config.NEWS_CHANNEL_IDS.includes(ctx.chat.id)) return;
  const post = ctx.channelPost;
  const text = post.text ?? post.caption ?? "";
  await relay(deps, ctx.api, ctx.chat.id, post.message_id, text);
});

/** Кто в чате админ: кеш на 10 минут, чтобы не спрашивать Telegram на каждое сообщение. */
const adminCache = new Map<string, { at: number; admin: boolean }>();
const ADMIN_CACHE_MS = 10 * 60_000;

/**
 * Может ли это сообщение уйти подписчикам. В канале пишут только админы, а в
 * обычном чате — кто угодно: без проверки любой участник мог бы написать
 * «#всем» и разослать что угодно всем пользователям бота. Поэтому из чата
 * берём только админов чата, админов бота, сообщения от имени самого чата
 * (анонимный админ) и автопересылку из привязанного канала.
 */
export async function trustedNewsSender(ctx: BotContext): Promise<boolean> {
  const msg = ctx.msg;
  if (!msg || !ctx.chat) return false;
  if (msg.sender_chat && (msg.sender_chat.id === ctx.chat.id || msg.is_automatic_forward)) return true;
  const from = msg.from;
  if (!from || from.is_bot) return false;
  if (ctx.deps.config.ADMIN_IDS.includes(from.id)) return true;
  const key = `${ctx.chat.id}:${from.id}`;
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return hit.admin;
  let admin = false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, from.id);
    admin = member.status === "creator" || member.status === "administrator";
  } catch (err) {
    logger.warn({ err: String(err), chat: ctx.chat.id }, "news: не смог проверить, админ ли автор");
  }
  adminCache.set(key, { at: Date.now(), admin });
  return admin;
}

// The same for ordinary group chats listed as news sources.
newsHandlers.on("message", async (ctx, next) => {
  const deps = ctx.deps;
  if (ctx.chat.type === "private" || !deps.config.NEWS_CHANNEL_IDS.includes(ctx.chat.id)) return next();
  const text = ctx.msg.text ?? ctx.msg.caption ?? "";
  if (!(await trustedNewsSender(ctx))) {
    if (topicsForText(text) === "all" || (topicsForText(text) as Topic[]).length) logger.info({ chat: ctx.chat.id, from: ctx.from?.id }, "news: пост с хэштегом не от админа чата, не пересылаю");
    return;
  }
  await relay(deps, ctx.api, ctx.chat.id, ctx.msg.message_id, text);
});
