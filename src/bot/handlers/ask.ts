import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { BTN } from "../keyboards.js";
import { clearPending, setPending, takePending } from "../context.js";
import { needGroup } from "../views.js";
import { esc } from "../../schedule/format.js";
import { todayMsk } from "../../time.js";
import { logger } from "../../logger.js";

export const askHandlers = new Composer<BotContext>();

async function answer(ctx: BotContext, question: string): Promise<void> {
  const ask = ctx.deps.ask;
  if (!ask) return void (await ctx.reply("Вопросы своими словами пока выключены."));
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply("Сначала выбери группу: /group"));
  const day = todayMsk();
  const used = ctx.deps.repo.aiUsage(ctx.user.id, day);
  if (used >= ctx.deps.config.AI_DAILY_LIMIT_PER_USER) {
    return void (await ctx.reply(`На сегодня лимит вопросов исчерпан (${ctx.deps.config.AI_DAILY_LIMIT_PER_USER} в день). Кнопки работают без лимита 🙂`));
  }
  if (ctx.deps.repo.aiUsageGlobal(day) >= ctx.deps.config.AI_DAILY_LIMIT_GLOBAL) {
    return void (await ctx.reply("Сегодня бот уже много отвечал, дневной бюджет вопросов закончился. Завтра продолжим."));
  }
  await ctx.replyWithChatAction("typing");
  try {
    const res = await ask.answer({ question, group, subgroup: ctx.user.subgroup, userId: ctx.user.id });
    ctx.deps.repo.bumpAiUsage(ctx.user.id, day, res.inputTokens, res.outputTokens);
    await ctx.reply(res.text, { parse_mode: "HTML" }).catch(() => ctx.reply(res.text.replace(/<[^>]+>/g, "")));
  } catch (err) {
    logger.error({ err }, "ask failed");
    await ctx.reply(`Не получилось ответить: ${esc(String(err)).slice(0, 200)}`, { parse_mode: "HTML" });
  }
}

askHandlers.command("ask", async (ctx) => {
  const q = (ctx.match ?? "").trim();
  if (!q) {
    if (!ctx.deps.ask) return void (await ctx.reply("Вопросы своими словами пока выключены."));
    setPending(ctx.deps, ctx.user.id, { kind: "ask" }, 3 * 60_000);
    return void (await ctx.reply("Спрашивай: например, «когда у нас следующая физика?» или «сколько пар в четверг?»"));
  }
  await answer(ctx, q);
});

askHandlers.hears(BTN.ask, async (ctx) => {
  if (!ctx.deps.ask) return void (await ctx.reply("Вопросы своими словами пока выключены."));
  setPending(ctx.deps, ctx.user.id, { kind: "ask" }, 3 * 60_000);
  await ctx.reply("Спрашивай про расписание своими словами. Отмена: /cancel");
});

askHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "ask") return next();
  if (ctx.msg.text.startsWith("/")) return next();
  clearPending(ctx.deps, ctx.user.id);
  await answer(ctx, ctx.msg.text);
});
