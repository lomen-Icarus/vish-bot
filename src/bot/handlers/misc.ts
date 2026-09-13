import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, mainKeyboard } from "../keyboards.js";
import { helpText, needGroup } from "../views.js";
import { showGroupPicker } from "./schedule.js";
import { esc } from "../../schedule/format.js";
import { dayView } from "../views.js";
import { findGroup } from "../../schedule/groups.js";
import { addDays, parseRuDate, todayMsk } from "../../time.js";
import { logger } from "../../logger.js";

export const miscHandlers = new Composer<BotContext>();

miscHandlers.command("start", async (ctx) => {
  const deps = ctx.deps;
  const kb = mainKeyboard({ ask: !!deps.ask, suggest: deps.config.MEDIA_CHAT_IDS.length > 0 });
  const group = needGroup(ctx);
  if (!group) {
    await ctx.reply(
      "Привет! Я бот расписания Высшей инженерной школы ЧувГУ.\n\nПокажу пары на любой день, пришлю изменения в расписании и напомню о парах. Сначала выбери группу.",
      { reply_markup: kb },
    );
    await showGroupPicker(ctx);
    return;
  }
  await ctx.reply(`С возвращением! Твоя группа: <b>${esc(group.title)}</b>.`, { parse_mode: "HTML", reply_markup: kb });
});

miscHandlers.command("help", (ctx) => ctx.reply(helpText(ctx.deps), { parse_mode: "HTML" }));

// ---- suggest news to media team ----
async function startSuggest(ctx: BotContext): Promise<void> {
  if (ctx.deps.config.MEDIA_CHAT_IDS.length === 0) {
    await ctx.reply("Приём новостей пока не настроен. Напиши напрямую медиа-ВИШ.");
    return;
  }
  setPending(ctx.deps, ctx.user.id, { kind: "suggest" }, 10 * 60_000);
  await ctx.reply("Пришли новость, достижение или объявление одним сообщением: текст, фото или документ. Я передам его медиа-ВИШ. Отмена: /cancel");
}
miscHandlers.command("suggest", startSuggest);
miscHandlers.hears(BTN.suggest, startSuggest);
miscHandlers.command("cancel", async (ctx) => {
  clearPending(ctx.deps, ctx.user.id);
  await ctx.reply("Отменено.");
});

miscHandlers.on("message", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "suggest") return next();
  if (ctx.msg.text?.startsWith("/")) return next();
  clearPending(ctx.deps, ctx.user.id);
  const group = needGroup(ctx);
  const from = ctx.from;
  const header = `📨 <b>Предложение от</b> ${from?.username ? `@${esc(from.username)}` : esc(from?.first_name ?? "аноним")}${group ? ` (${esc(group.title)})` : ""} · id <code>${from?.id}</code>`;
  let delivered = 0;
  for (const chatId of ctx.deps.config.MEDIA_CHAT_IDS) {
    try {
      await ctx.api.sendMessage(chatId, header, { parse_mode: "HTML" });
      await ctx.api.forwardMessage(chatId, ctx.chat.id, ctx.msg.message_id);
      delivered++;
    } catch (err) {
      logger.warn({ err, chatId }, "failed to deliver suggestion");
    }
  }
  await ctx.reply(delivered ? "Передал медиа-ВИШ, спасибо! 🙌" : "Не получилось доставить, попробуй позже.");
});

// ---- inline mode: @bot 12-23 завтра ----
miscHandlers.on("inline_query", async (ctx) => {
  const deps = ctx.deps;
  const q = ctx.inlineQuery.query.trim();
  const groups = deps.service.groups();
  const words = q.split(/\s+/).filter(Boolean);
  let date = todayMsk();
  const dateWord = words.find((w) => /^(сегодня|завтра|\d{1,2}[./]\d{1,2}([./]\d{2,4})?)$/iu.test(w));
  if (dateWord) {
    if (/завтра/iu.test(dateWord)) date = addDays(date, 1);
    else if (!/сегодня/iu.test(dateWord)) date = parseRuDate(dateWord) ?? date;
  }
  const groupQuery = words.filter((w) => w !== dateWord).join(" ");
  let candidates = groupQuery ? findGroup(groups, groupQuery) : [];
  if (!candidates.length && !groupQuery && ctx.user.groupKey) {
    const own = deps.service.group(ctx.user.groupKey);
    if (own) candidates = [own];
  }
  if (!candidates.length && !groupQuery) candidates = groups.slice(0, 10);
  const results = candidates.slice(0, 10).map((g) => {
    const { text } = dayView(deps, g, date, null);
    return {
      type: "article" as const,
      id: `${g.key}:${date}`.slice(0, 64),
      title: `${g.title} — ${date === todayMsk() ? "сегодня" : date}`,
      description: text.replace(/<[^>]+>/g, "").split("\n").slice(2, 6).join(" · ").slice(0, 100),
      input_message_content: { message_text: text.slice(0, 4000), parse_mode: "HTML" as const },
    };
  });
  await ctx.answerInlineQuery(results, { cache_time: 60, is_personal: true });
});
