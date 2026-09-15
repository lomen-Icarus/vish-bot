import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, isMenuText } from "../keyboards.js";
import { clearPending, setPending, takePending } from "../context.js";
import { needGroup } from "../views.js";
import { clampHtml, esc } from "../../schedule/format.js";
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
    const logId = ctx.deps.repo.logAi(ctx.user.id, question, res.text);
    const kb = new InlineKeyboard().text("👎 Ответ неверный", `aiw:${logId}`);
    await ctx.reply(res.text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(res.text.replace(/<[^>]+>/g, ""), { reply_markup: kb }));
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

askHandlers.callbackQuery(/^aiw:(\d+)$/, async (ctx) => {
  const entry = ctx.deps.repo.aiLogEntry(Number(ctx.match[1]));
  if (!entry) return void (await ctx.answerCallbackQuery({ text: "Запись не найдена" }));
  if (entry.reported) return void (await ctx.answerCallbackQuery({ text: "Уже передано админу, спасибо" }));
  ctx.deps.repo.markAiReported(entry.id);
  await ctx.answerCallbackQuery({ text: "Спасибо, передал админу" });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("✅ Жалоба отправлена", "noop") });
  } catch {
    /* ignore */
  }
  const from = ctx.from;
  const group = needGroup(ctx);
  const report = `👎 <b>ИИ ответил неверно</b> (${from.username ? `@${esc(from.username)}` : esc(from.first_name)}${group ? `, ${esc(group.title)}` : ""}, id <code>${from.id}</code>)\n\n<b>Вопрос:</b> ${esc(entry.question)}\n\n<b>Ответ:</b>\n${entry.answer}`;
  for (const adminId of ctx.deps.config.ADMIN_IDS) {
    try {
      await ctx.api.sendMessage(adminId, clampHtml(report), { parse_mode: "HTML" });
    } catch (err) {
      logger.warn({ err: String(err), adminId }, "ai report delivery failed");
    }
  }
});

askHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "ask") return next();
  if (ctx.msg.text.startsWith("/")) return next();
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  clearPending(ctx.deps, ctx.user.id);
  await answer(ctx, ctx.msg.text);
});
