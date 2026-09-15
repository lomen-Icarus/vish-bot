import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, teacherDayNav, teacherWeekNav } from "../keyboards.js";
import { esc, formatDay, formatWeek } from "../../schedule/format.js";
import type { LogicalGroup } from "../../schedule/groups.js";
import type { Occurrence } from "../../schedule/model.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../../time.js";
import type { TeacherRef } from "../../portal/teachers.js";
import { logger } from "../../logger.js";

export const teacherHandlers = new Composer<BotContext>();

const UNAVAILABLE = "Расписание преподавателей портал показывает только авторизованным. Попроси админа добавить учётку портала в настройки бота (PORTAL_LOGIN / PORTAL_PASSWORD), и раздел заработает.";

function pseudoGroup(t: TeacherRef, fullName: string | null): LogicalGroup {
  return { key: `teacher:${t.id}`, title: fullName ?? t.name, prefix: "", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] };
}

async function askName(ctx: BotContext): Promise<void> {
  if (!ctx.deps.teachers) return void (await ctx.reply(UNAVAILABLE));
  setPending(ctx.deps, ctx.user.id, { kind: "teacher" }, 3 * 60_000);
  await ctx.reply("Напиши фамилию преподавателя, можно с именем или инициалами в любом порядке: <code>Иванова</code>, <code>Дарья Иванова</code>, <code>Иванова Д.А.</code> Отмена: /cancel", { parse_mode: "HTML" });
}

teacherHandlers.command("teachers", askName);
teacherHandlers.hears(BTN.teachers, askName);
teacherHandlers.callbackQuery("t:search", async (ctx) => {
  await ctx.answerCallbackQuery();
  await askName(ctx);
});

teacherHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "teacher") return next();
  if (ctx.msg.text.startsWith("/")) return next();
  clearPending(ctx.deps, ctx.user.id);
  const teachers = ctx.deps.teachers;
  if (!teachers) return void (await ctx.reply(UNAVAILABLE));
  await ctx.replyWithChatAction("typing");
  const found = await teachers.search(ctx.msg.text);
  if (!found.length) {
    const err = teachers.lastError();
    const hint = err && ctx.isAdmin ? `\n\n<i>Админу: последняя ошибка портала — ${esc(err)}</i>` : "";
    return void (await ctx.reply(`Никого не нашёл по «${esc(ctx.msg.text)}». Попробуй одну фамилию без имени или первые буквы фамилии; имя и фамилию можно в любом порядке.${hint}`, { parse_mode: "HTML" }));
  }
  if (found.length === 1) return showTeacherDay(ctx, found[0]!, todayMsk());
  const kb = new InlineKeyboard();
  for (const t of found) kb.text(t.name, `t:${t.id}`).row();
  await ctx.reply("Кого показать?", { reply_markup: kb });
});

teacherHandlers.callbackQuery(/^t:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const t = await ctx.deps.teachers?.byId(Number(ctx.match[1]));
  if (!t) return void (await ctx.reply("Преподаватель не найден, поищи заново: " + BTN.teachers));
  await showTeacherDay(ctx, t, todayMsk());
});

teacherHandlers.callbackQuery(/^td:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const t = await ctx.deps.teachers?.byId(Number(ctx.match[1]));
  if (!t) return;
  await showTeacherDay(ctx, t, ctx.match[2]!, true);
});

teacherHandlers.callbackQuery(/^tw:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const t = await ctx.deps.teachers?.byId(Number(ctx.match[1]));
  if (!t) return;
  await showTeacherWeek(ctx, t, ctx.match[2]!, true);
});

async function showTeacherDay(ctx: BotContext, t: TeacherRef, date: LocalDate, edit = false): Promise<void> {
  const teachers = ctx.deps.teachers!;
  try {
    const { lessons, fullName } = await teachers.lessons(t, date, date);
    const text = formatDay(pseudoGroup(t, fullName), date, lessons, ctx.deps.service.weekInfo(date), todayMsk(), { now: wallClock() });
    const kb = teacherDayNav(t.id, date, todayMsk());
    if (edit) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
        return;
      } catch (err) {
        if (String(err).includes("message is not modified")) return;
      }
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (err) {
    logger.warn({ err: String(err), teacher: t.id }, "teacher schedule failed");
    await ctx.reply(`Не удалось загрузить расписание ${esc(t.name)}: портал не ответил. Попробуй позже.`, { parse_mode: "HTML" });
  }
}

async function showTeacherWeek(ctx: BotContext, t: TeacherRef, anyDate: LocalDate, edit = false): Promise<void> {
  const teachers = ctx.deps.teachers!;
  const monday = mondayOf(anyDate);
  try {
    const { lessons, fullName } = await teachers.lessons(t, monday, addDays(monday, 6));
    const byDate = new Map<LocalDate, Occurrence[]>();
    for (const o of lessons) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);
    const text = formatWeek(pseudoGroup(t, fullName), monday, byDate, ctx.deps.service.weekInfo(monday), todayMsk());
    const kb = teacherWeekNav(t.id, monday);
    if (edit) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
        return;
      } catch (err) {
        if (String(err).includes("message is not modified")) return;
      }
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (err) {
    logger.warn({ err: String(err), teacher: t.id }, "teacher week failed");
    await ctx.reply(`Не удалось загрузить расписание ${esc(t.name)}: портал не ответил. Попробуй позже.`, { parse_mode: "HTML" });
  }
}
