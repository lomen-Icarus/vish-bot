import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, groupCb, isMenuText } from "../keyboards.js";
import { clearPending, setPending, takePending } from "../context.js";
import { featuresText, needGroup } from "../views.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { addDays, mondayOf, todayMsk } from "../../time.js";
import type { Occurrence } from "../../schedule/model.js";
import { ownTeacherRef } from "../teacherMode.js";
import { loadProfile, profileLessons } from "../../people/profile.js";
import { aiAllowance, aiLimits } from "../../ai/limits.js";
import type { AskMentions } from "../../ai/ask.js";
import { teacherVishTag } from "./teachers.js";
import { showPerson, webinarRef } from "../people.js";
import { hitLabel } from "../../people/search.js";
import { refKey, type PersonRef } from "../../people/ref.js";
import { samePerson } from "../../text/match.js";
import { logger } from "../../logger.js";
import { ershovNamesakes, isErshovQuery, sendErshovCard } from "../easter.js";

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
  // Пасхалка про того, с чьей подачи в боте появились преподаватели. Если в
  // расписании есть настоящий однофамилец, вопрос идёт дальше, к ИИ.
  if (isErshovQuery(question)) {
    await sendErshovCard(ctx);
    const real = await ershovNamesakes(ctx.deps, question, { id: ctx.user.id, isAdmin: ctx.isAdmin });
    if (!ask || !real.length) return "answered";
  }
  if (!ask) return "disabled";
  const day = todayMsk();
  const { verdict } = aiAllowance(ctx.deps.repo, ctx.deps.config, ctx.user.id, ctx.isAdmin, day, { user: inFlightByUser.get(ctx.user.id) ?? 0, global: inFlightGlobal });
  if (verdict !== "ok") return verdict;
  await ctx.replyWithChatAction("typing");
  inFlightByUser.set(ctx.user.id, (inFlightByUser.get(ctx.user.id) ?? 0) + 1);
  inFlightGlobal++;
  try {
    const self = ctx.user.teacherMode ? await ownTeacherContext(ctx) : undefined;
    const res = await ask.answer({ question, group: self ? null : needGroup(ctx), subgroup: ctx.user.subgroup, userId: ctx.user.id, botHelp: featuresText(ctx.deps), self });
    ctx.deps.repo.bumpAiUsage(ctx.user.id, day, res.inputTokens, res.outputTokens);
    const logId = ctx.deps.repo.logAi(ctx.user.id, question, res.text);
    // Copy the caller's rows: mutating their keyboard would move buttons between messages.
    // Пустые ряды Telegram не принимает, а localSearch их иногда оставляет.
    const kb = new InlineKeyboard((opts.extraButtons?.inline_keyboard ?? []).filter((row) => row.length).map((row) => [...row]));
    appendMentions(ctx, kb, res.mentions);
    kb.row().text("👎 Ответ неверный", `aiw:${logId}`);
    const text = clampHtml(res.text);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, ""), { reply_markup: kb }));
    // Нашёлся ровно один человек — следом его карточка, та же, что из кнопок.
    const person = soleExactPerson(res.mentions);
    if (person) await showPerson(ctx, person, todayMsk()).catch((err: unknown) => logger.warn({ err: String(err) }, "ask: person card failed"));
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

/** Режим преподавателя: ФИО и его пары на две недели — вместо расписания группы. */
async function ownTeacherContext(ctx: BotContext): Promise<{ name: string; lessons: Occurrence[] } | undefined> {
  const ref = ownTeacherRef(ctx.user);
  const name = ctx.user.teacherName ?? "преподаватель";
  if (!ref) return { name, lessons: [] };
  try {
    const profile = await loadProfile(ctx.deps, ref);
    if (!profile) return { name, lessons: [] };
    const from = mondayOf(todayMsk());
    const loaded = await profileLessons(ctx.deps, profile, from, addDays(from, 13));
    return { name: loaded.fullName ?? name, lessons: loaded.lessons };
  } catch (err) {
    logger.debug({ err: String(err) }, "ask: own teacher schedule failed");
    return { name, lessons: [] };
  }
}

/**
 * Кнопки на то, что ИИ нашёл: людей и группы. Подписи и карточка — те же,
 * что у кнопок «👨‍🏫 Преподаватели» и «Где студент»: человек выглядит
 * одинаково, как бы его ни искали.
 */
function appendMentions(ctx: BotContext, kb: InlineKeyboard, mentions: AskMentions): void {
  const taken = new Set(kb.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : "")));
  const today = todayMsk();
  const items: Array<[string, string]> = [];
  const add = (label: string, data: string): void => {
    if (taken.has(data) || items.length >= 6) return;
    taken.add(data);
    items.push([label, data]);
  };
  // «Наши» — ниже остальных, ближе к полю ввода: туда и смотрят, и жмут.
  const tagged = mentions.teachers.map((t) => ({ t, vish: !!teacherVishTag(ctx.deps.repo, t.id, t.name) }));
  tagged.sort((a, b) => Number(a.vish) - Number(b.vish));
  for (const { t, vish } of tagged) add(hitLabel({ role: "teacher", name: t.name, vish }), `ppo:${refKey({ kind: "teacher", id: t.id })}`);
  // Преподаватель онлайн-пары ВИШ — всегда наш, карта для этого не нужна.
  for (const w of mentions.webinarTeachers) add(hitLabel({ role: "teacher", name: w.name, vish: true, webinarOnly: true }), `ppo:${refKey(webinarRef(w.name))}`);
  for (const st of mentions.students) add(hitLabel({ role: "student", name: st.name, vish: true, groupTitle: st.groupTitle }), `ppo:${refKey({ kind: "student", id: st.id })}`);
  for (const key of mentions.groupKeys) {
    const g = ctx.deps.service.group(key);
    if (g && g.key !== ctx.user.groupKey) add(`📅 ${g.title}`, groupCb("pdn", g.key, today));
  }
  // Only touch the keyboard when there is something to add: an empty row would
  // travel to Telegram as a broken markup.
  items.forEach(([label, data], i) => {
    if (i % 2 === 0) kb.row();
    kb.text(label, data);
  });
}

/**
 * Единственный человек, которого ИИ нашёл точно, — его карточку бот пришлёт
 * следом за ответом. Несколько или только «похожие» — остаются кнопки.
 */
export function soleExactPerson(mentions: AskMentions): PersonRef | null {
  const refs = new Map<string, PersonRef>();
  for (const t of mentions.teachers) if (t.exact) refs.set(refKey({ kind: "teacher", id: t.id }), { kind: "teacher", id: t.id });
  for (const w of mentions.webinarTeachers) if (w.exact) refs.set(refKey(webinarRef(w.name)), webinarRef(w.name));
  for (const st of mentions.students) if (st.exact) refs.set(refKey({ kind: "student", id: st.id }), { kind: "student", id: st.id });
  // Тот же человек и из справочника, и со страницы вебинаров — один человек.
  const teachersExact = mentions.teachers.filter((t) => t.exact);
  if (teachersExact.length === 1) for (const w of mentions.webinarTeachers) if (w.exact && samePerson(w.name, teachersExact[0]!.name)) refs.delete(refKey(webinarRef(w.name)));
  if (mentions.teachers.some((t) => !t.exact) || mentions.webinarTeachers.some((w) => !w.exact) || mentions.students.some((s) => !s.exact)) return null;
  return refs.size === 1 ? [...refs.values()][0]! : null;
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
