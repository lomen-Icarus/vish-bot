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
      const msg = String(err);
      if (/blocked|deactivated|chat not found/i.test(msg)) deps.repo.updateUser(u.id, { blocked: true });
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

// The same for ordinary group chats listed as news sources.
newsHandlers.on("message", async (ctx, next) => {
  const deps = ctx.deps;
  if (ctx.chat.type === "private" || !deps.config.NEWS_CHANNEL_IDS.includes(ctx.chat.id)) return next();
  const text = ctx.msg.text ?? ctx.msg.caption ?? "";
  await relay(deps, ctx.api, ctx.chat.id, ctx.msg.message_id, text);
});
