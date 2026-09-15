import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, isMenuText } from "../keyboards.js";
import { clearPending, setPending, takePending } from "../context.js";
import { featuresText, needGroup } from "../views.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { todayMsk } from "../../time.js";
import { aiAllowance, aiLimits } from "../../ai/limits.js";
import type { AskMentions } from "../../ai/ask.js";
import { webinarKey } from "./teachers.js";
import { logger } from "../../logger.js";

export const askHandlers = new Composer<BotContext>();

export type AskOutcome = "answered" | "disabled" | "limit-user" | "limit-global" | "failed";

/**
 * Ask the model and deliver the answer. Shared by /ask and the search button,
 * so both obey the same daily limits and both carry the "wrong answer" button.
 * `extraButtons` are appended under the answer, e.g. links the local search found.
 */
export async function askAi(ctx: BotContext, question: string, opts: { extraButtons?: InlineKeyboard } = {}): Promise<AskOutcome> {
  const ask = ctx.deps.ask;
  if (!ask) return "disabled";
  const day = todayMsk();
  const { verdict } = aiAllowance(ctx.deps.repo, ctx.deps.config, ctx.user.id, ctx.isAdmin, day);
  if (verdict !== "ok") return verdict;
  await ctx.replyWithChatAction("typing");
  try {
    const res = await ask.answer({ question, group: needGroup(ctx), subgroup: ctx.user.subgroup, userId: ctx.user.id, botHelp: featuresText(ctx.deps) });
    ctx.deps.repo.bumpAiUsage(ctx.user.id, day, res.inputTokens, res.outputTokens);
    const logId = ctx.deps.repo.logAi(ctx.user.id, question, res.text);
    // Copy the caller's rows: mutating their keyboard would move buttons between messages.
    const kb = new InlineKeyboard([...(opts.extraButtons?.inline_keyboard ?? []).map((row) => [...row])]);
    appendMentions(ctx, kb, res.mentions);
    kb.row().text("👎 Ответ неверный", `aiw:${logId}`);
    const text = clampHtml(res.text);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, ""), { reply_markup: kb }));
    return "answered";
  } catch (err) {
    logger.error({ err }, "ask failed");
    return "failed";
  }
}

/**
 * Кнопки на то, что ИИ нашёл: людей и группы. Человек ошибся в фамилии — модель
 * предлагает похожих словами, а нажать их можно здесь.
 */
function appendMentions(ctx: BotContext, kb: InlineKeyboard, mentions: AskMentions): void {
  const taken = new Set(kb.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : "")));
  const today = todayMsk();
  const items: Array<[string, string]> = [];
  const add = (label: string, data: string): void => {
    if (taken.has(data) || items.length >= 6) return;
    taken.add(data);
    items.push([label.slice(0, 40), data]);
  };
  for (const t of mentions.teachers) add(`👨‍🏫 ${t.name}`, `t:${t.id}`);
  for (const name of mentions.webinarTeachers) add(`👨‍🏫 ${name}`, webinarKey(name));
  for (const key of mentions.groupKeys) {
    const g = ctx.deps.service.group(key);
    if (g && g.key !== ctx.user.groupKey) add(`📅 ${g.title}`, `pdn:${g.key}:${today}`);
  }
  // Only touch the keyboard when there is something to add: an empty row would
  // travel to Telegram as a broken markup.
  items.forEach(([label, data], i) => {
    if (i % 2 === 0) kb.row();
    kb.text(label, data);
  });
}

async function answer(ctx: BotContext, question: string): Promise<void> {
  const outcome = await askAi(ctx, question);
  if (outcome === "answered") return;
  if (outcome === "disabled") return void (await ctx.reply("Вопросы своими словами пока выключены."));
  if (outcome === "limit-user") return void (await ctx.reply(`На сегодня твой лимит вопросов исчерпан (${aiLimits(ctx.deps.repo, ctx.deps.config, todayMsk()).perUser} в день). Кнопки работают без лимита 🙂`));
  if (outcome === "limit-global") return void (await ctx.reply("Сегодня бот уже много отвечал, общий дневной бюджет вопросов закончился. Завтра продолжим."));
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
