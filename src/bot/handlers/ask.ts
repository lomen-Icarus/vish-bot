import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, isMenuText } from "../keyboards.js";
import { clearPending, setPending, takePending } from "../context.js";
import { featuresText, needGroup } from "../views.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { todayMsk } from "../../time.js";
import { logger } from "../../logger.js";

export const askHandlers = new Composer<BotContext>();

export type AskOutcome = "answered" | "disabled" | "limit" | "failed";

/**
 * Ask the model and deliver the answer. Shared by /ask and the search button,
 * so both obey the same daily limits and both carry the "wrong answer" button.
 * `extraButtons` are appended under the answer, e.g. links the local search found.
 */
export async function askAi(ctx: BotContext, question: string, opts: { extraButtons?: InlineKeyboard } = {}): Promise<AskOutcome> {
  const ask = ctx.deps.ask;
  if (!ask) return "disabled";
  const day = todayMsk();
  if (ctx.deps.repo.aiUsage(ctx.user.id, day) >= ctx.deps.config.AI_DAILY_LIMIT_PER_USER) return "limit";
  if (ctx.deps.repo.aiUsageGlobal(day) >= ctx.deps.config.AI_DAILY_LIMIT_GLOBAL) return "limit";
  await ctx.replyWithChatAction("typing");
  try {
    const res = await ask.answer({ question, group: needGroup(ctx), subgroup: ctx.user.subgroup, userId: ctx.user.id, botHelp: featuresText(ctx.deps) });
    ctx.deps.repo.bumpAiUsage(ctx.user.id, day, res.inputTokens, res.outputTokens);
    const logId = ctx.deps.repo.logAi(ctx.user.id, question, res.text);
    const kb = opts.extraButtons ?? new InlineKeyboard();
    kb.row().text("👎 Ответ неверный", `aiw:${logId}`);
    const text = clampHtml(res.text);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, ""), { reply_markup: kb }));
    return "answered";
  } catch (err) {
    logger.error({ err }, "ask failed");
    return "failed";
  }
}

async function answer(ctx: BotContext, question: string): Promise<void> {
  const outcome = await askAi(ctx, question);
  if (outcome === "answered") return;
  if (outcome === "disabled") return void (await ctx.reply("Вопросы своими словами пока выключены."));
  if (outcome === "limit") return void (await ctx.reply(`На сегодня лимит вопросов исчерпан (${ctx.deps.config.AI_DAILY_LIMIT_PER_USER} в день). Кнопки работают без лимита 🙂`));
  await ctx.reply("Не получилось ответить, попробуй ещё раз или воспользуйся кнопками.");
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
