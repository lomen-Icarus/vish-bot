import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, groupPicker, onboardingKeyboard } from "../keyboards.js";
import { groupRequiredText, needGroup, sendDay, sendWeek } from "../views.js";
import { addDays, isLocalDate, mondayOf, parseRuDate, todayMsk } from "../../time.js";
import { esc, formatChangeEvent, formatNotice } from "../../schedule/format.js";
import type { ChangeEvent } from "../../schedule/diff.js";
import { findGroup } from "../../schedule/groups.js";

export const scheduleHandlers = new Composer<BotContext>();

async function showDay(ctx: BotContext, offset: number): Promise<void> {
  const group = needGroup(ctx);
  if (!group) {
    await ctx.reply(groupRequiredText());
    return;
  }
  await sendDay(ctx, group, addDays(todayMsk(), offset));
}

scheduleHandlers.command("today", (ctx) => showDay(ctx, 0));
scheduleHandlers.command("tomorrow", (ctx) => showDay(ctx, 1));
scheduleHandlers.hears(BTN.today, (ctx) => showDay(ctx, 0));
scheduleHandlers.hears(BTN.tomorrow, (ctx) => showDay(ctx, 1));

scheduleHandlers.command("week", async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  await sendWeek(ctx, group, todayMsk());
});
scheduleHandlers.hears(BTN.week, async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  await sendWeek(ctx, group, todayMsk());
});
scheduleHandlers.hears(BTN.nextWeek, async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  await sendWeek(ctx, group, addDays(mondayOf(todayMsk()), 7));
});

scheduleHandlers.command("date", async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  const date = parseRuDate(ctx.match ?? "");
  if (!date) return void (await ctx.reply("Напиши дату как <code>14.09</code> или <code>14.09.2026</code>", { parse_mode: "HTML" }));
  await sendDay(ctx, group, date);
});

// Plain date typed into the chat: "14.09"
scheduleHandlers.hears(/^\s*\d{1,2}[./]\d{1,2}([./]\d{2,4})?\s*$/, async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  const date = parseRuDate(ctx.match[0]);
  if (!date) return;
  await sendDay(ctx, group, date);
});

// Callback navigation
scheduleHandlers.callbackQuery(/^d:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = needGroup(ctx);
  await ctx.answerCallbackQuery();
  if (!group) return void (await ctx.reply(groupRequiredText()));
  await sendDay(ctx, group, ctx.match[1]!, { edit: true });
});
scheduleHandlers.callbackQuery(/^img:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = needGroup(ctx);
  await ctx.answerCallbackQuery({ text: "Рисую…" });
  if (!group) return;
  await sendDay(ctx, group, ctx.match[1]!, { forceImage: true });
});
scheduleHandlers.callbackQuery(/^w:(today|\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = needGroup(ctx);
  await ctx.answerCallbackQuery();
  if (!group) return void (await ctx.reply(groupRequiredText()));
  const d = ctx.match[1] === "today" ? todayMsk() : ctx.match[1]!;
  await sendWeek(ctx, group, d, { edit: true });
});
scheduleHandlers.callbackQuery(/^wimg:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = needGroup(ctx);
  await ctx.answerCallbackQuery({ text: "Рисую…" });
  if (!group) return;
  await sendWeek(ctx, group, ctx.match[1]!, { forceImage: true });
});
scheduleHandlers.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

// ---- group selection ----
export async function showGroupPicker(ctx: BotContext, text = "Выбери свою группу:"): Promise<void> {
  const groups = ctx.deps.service.groups();
  if (groups.length === 0) return void (await ctx.reply("Список групп ещё не загружен с портала, попробуй через минуту."));
  await ctx.reply(text, { reply_markup: groupPicker(groups, { selected: ctx.user.groupKey }) });
}

scheduleHandlers.command("group", (ctx) => showGroupPicker(ctx));

scheduleHandlers.callbackQuery(/^g:(.+)$/, async (ctx) => {
  const key = ctx.match[1]!;
  const group = ctx.deps.service.group(key);
  if (!group) return void (await ctx.answerCallbackQuery({ text: "Группа не найдена, список обновился", show_alert: true }));
  const firstTime = !ctx.user.groupKey;
  ctx.deps.repo.updateUser(ctx.user.id, { groupKey: group.key, subgroup: null });
  await ctx.answerCallbackQuery({ text: `Группа: ${group.title}` });
  try {
    await ctx.editMessageText(`Группа выбрана: <b>${esc(group.title)}</b>${group.portalIds.length > 1 ? `\n<i>Объединяет: ${group.portalNames.map(esc).join(", ")}</i>` : ""}`, { parse_mode: "HTML" });
  } catch {
    /* message may be gone */
  }
  if (firstTime) {
    await ctx.reply(
      "Включить уведомления с рекомендуемыми настройками?\n\n• изменения в расписании твоей группы\n• напоминание за 2 часа до первой пары\n\nВсё это потом можно поменять в ⚙️ Настройках.",
      { reply_markup: onboardingKeyboard() },
    );
  } else {
    const group2 = needGroup(ctx)!;
    await sendDay(ctx, group2, todayMsk());
  }
});

scheduleHandlers.callbackQuery(/^ob:(on|custom|later)$/, async (ctx) => {
  const choice = ctx.match[1];
  if (choice === "on") {
    ctx.deps.repo.updateUser(ctx.user.id, { notifyChanges: true, remindFirstMin: 120 });
    await ctx.answerCallbackQuery({ text: "Готово" });
    await ctx.editMessageText("✅ Уведомления включены: изменения в расписании + напоминание за 2 часа до первой пары.");
  } else if (choice === "custom") {
    ctx.deps.repo.updateUser(ctx.user.id, { notifyChanges: true });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Открой ⚙️ Настройки и включи то, что нужно.");
  } else {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Хорошо. Уведомления можно включить в ⚙️ Настройках.");
  }
  const group = needGroup(ctx);
  if (group) await sendDay(ctx, group, todayMsk());
});

// Typed group name: "12-23", "ВИШ-11-25"
scheduleHandlers.hears(/^\s*(оз\s*)?(виш)?[\s-]*\d{1,2}[\s-]+\d{2}\s*(\(.*\))?\s*$/iu, async (ctx) => {
  const groups = findGroup(ctx.deps.service.groups(), ctx.match[0]);
  if (groups.length === 1) {
    const g = groups[0]!;
    await ctx.reply(`Показать расписание <b>${esc(g.title)}</b> или сделать её твоей группой?`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "📅 Показать сегодня", callback_data: `peek:${g.key}` }, { text: "✅ Моя группа", callback_data: `g:${g.key}` }]] },
    });
  } else if (groups.length > 1) {
    await ctx.reply("Есть несколько похожих групп:", { reply_markup: groupPicker(groups) });
  } else {
    await ctx.reply("Не нашёл такую группу. Список: /group");
  }
});

scheduleHandlers.callbackQuery(/^peek:(.+)$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery();
  if (!group) return;
  await sendDay(ctx, group, todayMsk());
});

// ---- recent changes ----
async function showChanges(ctx: BotContext): Promise<void> {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  const events = ctx.deps.repo.recentEvents(group.key, 12);
  const banner = ctx.deps.repo.getMeta("banner");
  const parts: string[] = [];
  if (banner) parts.push(formatNotice(banner));
  if (events.length === 0) parts.push(`За последнее время изменений в расписании <b>${esc(group.title)}</b> бот не замечал.`);
  else {
    const lines = events.map((e) => {
      const p = e.payload as { before?: ChangeEvent["before"]; after?: ChangeEvent["after"]; fields?: string[] };
      const ev: ChangeEvent = { kind: e.kind as ChangeEvent["kind"], groupKey: e.groupKey, date: e.date, period: e.period, before: p.before, after: p.after, fields: p.fields };
      const when = e.createdAt.slice(0, 10);
      return `<i>${when.slice(8, 10)}.${when.slice(5, 7)}</i> ${formatChangeEvent(ev)}`;
    });
    parts.push(`<b>Последние изменения, ${esc(group.title)}</b>\n\n${lines.join("\n\n")}`);
  }
  await ctx.reply(parts.join("\n\n"), { parse_mode: "HTML" });
}
scheduleHandlers.command("changes", showChanges);
scheduleHandlers.hears(BTN.changes, showChanges);

export function validDate(s: string): s is string {
  return isLocalDate(s);
}
