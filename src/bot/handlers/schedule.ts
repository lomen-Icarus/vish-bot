import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, groupPicker, onboardingKeyboard } from "../keyboards.js";
import { groupRequiredText, needGroup, sendDay, sendWeek } from "../views.js";
import { addDays, fmtDDMM, isLocalDate, mondayOf, parseRuDate, todayMsk } from "../../time.js";
import { clampHtml, esc, formatChangeEvent } from "../../schedule/format.js";
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

// ---- own-group navigation ----
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

// ---- other groups ("peek") ----
async function showOtherGroups(ctx: BotContext): Promise<void> {
  const groups = ctx.deps.service.groups();
  if (!groups.length) return void (await ctx.reply("Список групп ещё не загружен с портала, попробуй через минуту."));
  await ctx.reply("Чьё расписание показать? Своя группа при этом не меняется.", { reply_markup: groupPicker(groups, { prefix: "pk", selected: ctx.user.groupKey }) });
}
scheduleHandlers.hears(BTN.otherGroups, showOtherGroups);
scheduleHandlers.command("groups", showOtherGroups);

scheduleHandlers.callbackQuery(/^pk:(.+)$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery();
  if (!group) return void (await ctx.reply("Группа не найдена, список обновился."));
  await sendDay(ctx, group, todayMsk(), { peek: true });
});
// "pdn:" opens a group in a NEW message (from the stream screen or search results);
// "pd:" navigates inside an existing day view and edits it in place.
scheduleHandlers.callbackQuery(/^pdn:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery();
  if (!group) return void (await ctx.reply("Группа не найдена, список обновился."));
  await sendDay(ctx, group, ctx.match[2]!, { peek: true });
});
scheduleHandlers.callbackQuery(/^pd:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery();
  if (!group) return void (await ctx.reply("Группа не найдена, список обновился."));
  await sendDay(ctx, group, ctx.match[2]!, { edit: true, peek: true });
});
scheduleHandlers.callbackQuery(/^pimg:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery({ text: "Рисую…" });
  if (!group) return;
  await sendDay(ctx, group, ctx.match[2]!, { forceImage: true, peek: true });
});
scheduleHandlers.callbackQuery(/^pw:(.+):(today|\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery();
  if (!group) return void (await ctx.reply("Группа не найдена, список обновился."));
  const d = ctx.match[2] === "today" ? todayMsk() : ctx.match[2]!;
  await sendWeek(ctx, group, d, { edit: true, peek: true });
});
scheduleHandlers.callbackQuery(/^pwimg:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery({ text: "Рисую…" });
  if (!group) return;
  await sendWeek(ctx, group, ctx.match[2]!, { forceImage: true, peek: true });
});
scheduleHandlers.callbackQuery(/^peek:(.+)$/, async (ctx) => {
  const group = ctx.deps.service.group(ctx.match[1]!);
  await ctx.answerCallbackQuery();
  if (!group) return;
  await sendDay(ctx, group, todayMsk(), { peek: true });
});

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
  // Keep the in-flight context in sync: later steps of this update read ctx.user.
  ctx.user.groupKey = group.key;
  ctx.user.subgroup = null;
  await ctx.answerCallbackQuery({ text: `Группа: ${group.title}` });
  try {
    if (ctx.callbackQuery.message && !("photo" in ctx.callbackQuery.message && ctx.callbackQuery.message.photo)) {
      await ctx.editMessageText(`Группа выбрана: <b>${esc(group.title)}</b>`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(`Группа выбрана: <b>${esc(group.title)}</b>`, { parse_mode: "HTML" });
    }
  } catch {
    /* message may be gone */
  }
  if (firstTime) {
    await ctx.reply(
      "Включить уведомления с рекомендуемыми настройками?\n\n• изменения в расписании твоей группы\n• напоминание за 2 часа до первой пары\n• за 5 минут до дистанционной пары — ссылка на вебинар\n\nВсё это потом можно поменять в ⚙️ Настройках.",
      { reply_markup: onboardingKeyboard() },
    );
  } else {
    await sendDay(ctx, group, todayMsk());
  }
});

scheduleHandlers.callbackQuery(/^ob:(on|custom|later)$/, async (ctx) => {
  const choice = ctx.match[1];
  if (choice === "on") {
    ctx.deps.repo.updateUser(ctx.user.id, { notifyChanges: true, remindFirstMin: 120, remindDistanceMin: 5 });
    await ctx.answerCallbackQuery({ text: "Готово" });
    await ctx.editMessageText("✅ Уведомления включены: изменения в расписании, напоминание за 2 часа до первой пары, ссылка на вебинар за 5 минут до дистанта.");
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
      reply_markup: new InlineKeyboard().text("📅 Показать сегодня", `pk:${g.key}`).text("✅ Моя группа", `g:${g.key}`),
    });
  } else if (groups.length > 1) {
    await ctx.reply("Есть несколько похожих групп:", { reply_markup: groupPicker(groups, { prefix: "pk" }) });
  } else {
    await ctx.reply("Не нашёл такую группу. Список: /group");
  }
});

// ---- "Изменения": announcements board + still-relevant changes ----
export function changesText(ctx: BotContext): { text: string; hasEvents: boolean } {
  const group = needGroup(ctx);
  const parts: string[] = [];
  const board = ctx.deps.repo.activeAnnouncements();
  if (board.length) {
    const items = board.map((a) => {
      const ago = Math.max(1, Math.round((Date.now() - Date.parse(a.createdAt)) / 3_600_000));
      return `• ${esc(a.text.length > 400 ? a.text.slice(0, 390).trimEnd() + "…" : a.text)}\n   <i>${ago} ч назад</i>`;
    });
    parts.push(`📌 <b>Объявления ВИШ</b>\n\n${items.join("\n\n")}`);
  }
  if (!group) {
    parts.push(groupRequiredText());
    return { text: parts.join("\n\n"), hasEvents: false };
  }
  const today = todayMsk();
  const events = ctx.deps.repo.activeEvents(group.key, today, 30);
  if (!events.length) {
    parts.push(`🔔 <b>Изменения в расписании ${esc(group.title)}</b>\n\nАктуальных изменений нет: бот проверяет портал каждые несколько минут и пришлёт, как только что-то поменяется.`);
    return { text: parts.join("\n\n"), hasEvents: false };
  }
  const byDate = new Map<string, string[]>();
  for (const e of events) {
    const p = e.payload as { before?: ChangeEvent["before"]; after?: ChangeEvent["after"]; fields?: string[] };
    const ev: ChangeEvent = { kind: e.kind as ChangeEvent["kind"], groupKey: e.groupKey, date: e.date, period: e.period, before: p.before, after: p.after, fields: p.fields };
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), formatChangeEvent(ev)]);
  }
  const blocks = [...byDate.entries()].map(([date, lines]) => `<b>${fmtDDMM(date)}</b>\n${lines.join("\n")}`);
  parts.push(`🔔 <b>Изменения в расписании ${esc(group.title)}</b>\n\n${blocks.join("\n\n")}`);
  return { text: parts.join("\n\n"), hasEvents: true };
}

async function showChanges(ctx: BotContext): Promise<void> {
  const { text, hasEvents } = changesText(ctx);
  const kb = new InlineKeyboard();
  if (hasEvents && ctx.user.groupKey) kb.text("📆 Обновить в календаре", `cics:${ctx.user.groupKey}`);
  await ctx.reply(clampHtml(text), { parse_mode: "HTML", reply_markup: hasEvents ? kb : undefined });
}
scheduleHandlers.command("changes", showChanges);
scheduleHandlers.hears(BTN.changes, showChanges);

export function validDate(s: string): s is string {
  return isLocalDate(s);
}
