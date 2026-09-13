import { Composer, InlineKeyboard, InputFile } from "grammy";
import type { BotContext } from "../context.js";
import { groupRequiredText, needGroup } from "../views.js";
import { buildIcs, icsFileName } from "../../schedule/ics.js";
import { filterSubgroup } from "../../schedule/format.js";
import { SEMESTER_WEEKS } from "../../schedule/service.js";
import { addDays, todayMsk } from "../../time.js";

export const calendarHandlers = new Composer<BotContext>();

export function calendarKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📆 Без напоминаний", "ics:0")
    .row()
    .text("⏰ за 15 мин", "ics:15")
    .text("⏰ за 30 мин", "ics:30")
    .text("⏰ за 60 мин", "ics:60");
}

async function offer(ctx: BotContext): Promise<void> {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  await ctx.reply(
    "Пришлю файл календаря со всеми парами до конца семестра. Открой его на телефоне, и календарь предложит добавить события. Хочешь напоминание-будильник перед каждой парой?",
    { reply_markup: calendarKeyboard() },
  );
}

calendarHandlers.command("calendar", offer);
calendarHandlers.callbackQuery("ics:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await offer(ctx);
});

calendarHandlers.callbackQuery(/^ics:(\d{1,3})$/, async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.answerCallbackQuery({ text: "Сначала выбери группу", show_alert: true }));
  const alarm = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Собираю календарь…" });
  const today = todayMsk();
  const service = ctx.deps.service;
  const anchor = service.weekOneMonday(service.semesterFor(today));
  const semesterEnd = anchor ? addDays(anchor, SEMESTER_WEEKS * 7 + 21) : addDays(today, 120);
  const to = semesterEnd < addDays(today, 150) ? semesterEnd : addDays(today, 150);
  const lessons = filterSubgroup(service.materialize(group, today, to), ctx.user.subgroup);
  const ics = buildIcs({ name: group.title, lessons, alarmMinutes: alarm > 0 ? alarm : null });
  const count = lessons.filter((o) => o.status === "scheduled").length;
  await ctx.replyWithDocument(new InputFile(Buffer.from(ics, "utf8"), icsFileName(group.title, today)), {
    caption: `${group.title}: ${count} пар с ${today.slice(8, 10)}.${today.slice(5, 7)} по ${to.slice(8, 10)}.${to.slice(5, 7)}${alarm ? `, напоминание за ${alarm} мин` : ""}.\n\nОткрой файл → «Добавить в календарь». Расписание меняется, поэтому раз в пару недель обновляй файл заново: старые события с теми же парами заменятся.`,
  });
});
