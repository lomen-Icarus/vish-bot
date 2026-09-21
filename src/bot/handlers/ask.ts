import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, isMenuText } from "../keyboards.js";
import { clearPending, setPending, takePending } from "../context.js";
import { featuresText, needGroup } from "../views.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { todayMsk } from "../../time.js";
import { aiAllowance, aiLimits } from "../../ai/limits.js";
import type { AskMentions } from "../../ai/ask.js";
import { teacherVishTag, webinarKey } from "./teachers.js";
import { logger } from "../../logger.js";

export const askHandlers = new Composer<BotContext>();

export type AskOutcome = "answered" | "disabled" | "limit-user" | "limit-global" | "failed";

/**
 * Вопросы, на которые модель отвечает прямо сейчас. Списание в базу происходит
 * только после ответа, а апдейты обрабатываются параллельно, поэтому без этого
 * счётчика два одновременных вопроса видели бы один и тот же остаток лимита.
 */
const inFlightByUser = new Map<number, number>();
let inFlightGlobal = 0;

/**
 * Ask the model and deliver the answer. Shared by /ask and the search button,
 * so both obey the same daily limits and both carry the "wrong answer" button.
 * `extraButtons` are appended under the answer, e.g. links the local search found.
 */
export async function askAi(ctx: BotContext, question: string, opts: { extraButtons?: InlineKeyboard } = {}): Promise<AskOutcome> {
  const ask = ctx.deps.ask;
  if (!ask) return "disabled";
  const day = todayMsk();
  const { verdict } = aiAllowance(ctx.deps.repo, ctx.deps.config, ctx.user.id, ctx.isAdmin, day, { user: inFlightByUser.get(ctx.user.id) ?? 0, global: inFlightGlobal });
  if (verdict !== "ok") return verdict;
  await ctx.replyWithChatAction("typing");
  inFlightByUser.set(ctx.user.id, (inFlightByUser.get(ctx.user.id) ?? 0) + 1);
  inFlightGlobal++;
  try {
    const res = await ask.answer({ question, group: needGroup(ctx), subgroup: ctx.user.subgroup, userId: ctx.user.id, botHelp: featuresText(ctx.deps) });
    ctx.deps.repo.bumpAiUsage(ctx.user.id, day, res.inputTokens, res.outputTokens);
    const logId = ctx.deps.repo.logAi(ctx.user.id, question, res.text);
    // Copy the caller's rows: mutating their keyboard would move buttons between messages.
    // Пустые ряды Telegram не принимает, а localSearch их иногда оставляет.
    const kb = new InlineKeyboard((opts.extraButtons?.inline_keyboard ?? []).filter((row) => row.length).map((row) => [...row]));
    appendMentions(ctx, kb, res.mentions);
    kb.row().text("👎 Ответ неверный", `aiw:${logId}`);
    const text = clampHtml(res.text);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, ""), { reply_markup: kb }));
    return "answered";
  } catch (err) {
    logger.error({ err }, "ask failed");
    return "failed";
  } finally {
    const left = (inFlightByUser.get(ctx.user.id) ?? 1) - 1;
    if (left > 0) inFlightByUser.set(ctx.user.id, left);
    else inFlightByUser.delete(ctx.user.id);
    inFlightGlobal = Math.max(0, inFlightGlobal - 1);
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
  // Один человек приходит и из справочника (t:<id>), и со страницы вебинаров
  // (wtc:<hash>) — по callback_data это разные кнопки, поэтому помним и имена.
  // Преподаватели и студенты считаются отдельно: «Троишестова Д.А.» и
  // «Троишестов Иван Сергеевич» дают одинаковый ключ, и кнопка на студента
  // пропадала бы из-за однофамильца-преподавателя.
  const names = { teacher: new Set<string>(), student: new Set<string>() };
  // «Иванова И.И.» и «Иванова Ирина Ивановна» — один человек: фамилия + инициалы.
  const key = (s: string): string => {
    const parts = s.toLowerCase().replace(/ё/g, "е").split(/[.\s]+/).filter(Boolean);
    return `${parts[0] ?? ""}|${parts.slice(1).map((w) => w[0]).join("")}`;
  };
  const add = (label: string, data: string, name?: string, kind: "teacher" | "student" = "teacher"): void => {
    if (taken.has(data) || items.length >= 6) return;
    if (name) {
      const k = key(name);
      if (names[kind].has(k)) return;
      names[kind].add(k);
    }
    taken.add(data);
    items.push([label.slice(0, 40), data]);
  };
  for (const t of mentions.teachers) add(`👨‍🏫 ${t.name}${teacherVishTag(ctx.deps.repo, t.id, t.name)}`, `t:${t.id}`, t.name);
  for (const name of mentions.webinarTeachers) add(`👨‍🏫 ${name}`, webinarKey(name), name);
  for (const st of mentions.students) add(`🕵️ ${st.name} · ${st.groupTitle}`, `pop:${st.id}`, st.name, "student");
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
  const report = `👎 <b>ИИ ответил неверно</b> (${from.username ? `@${esc(from.username)}` : esc(from.first_name)}${group ? `, ${esc(group.title)}` : ""}, id <code>${from.id}</code>)\n\n<b>Вопрос:</b> ${esc(entry.question)}\n\n<b>Ответ:</b>\n${esc(entry.answer)}`;
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
