import { Composer, InlineKeyboard, InputFile } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { groupRequiredText, needGroup } from "../views.js";
import { BTN, isMenuText } from "../keyboards.js";
import { icsFileName } from "../../schedule/ics.js";
import { calendarWindow, changesCalendar, groupCalendar } from "../../schedule/calendar.js";
import { buildIcs } from "../../schedule/ics.js";
import { ownTeacherRef } from "../teacherMode.js";
import { loadProfile, profileLessons } from "../../people/profile.js";
import { shortName } from "../../text/match.js";
import type { ChangeEvent } from "../../schedule/diff.js";
import { esc, plural } from "../../schedule/format.js";
import { calendarPath } from "../../http/server.js";
import { fmtDDMM, todayMsk } from "../../time.js";
import { publicBase } from "../../http/publicUrl.js";

export const calendarHandlers = new Composer<BotContext>();

function subscriptionsEnabled(ctx: BotContext): boolean {
  // A busy port or a failed listen() must not leave the bot handing out dead links.
  // Лента подписки строится по группе, поэтому в режиме преподавателя — только файл.
  return !!publicBase(ctx.deps) && ctx.deps.http?.listening === true && !ctx.user.teacherMode;
}

/** Календарь преподавателя (режим преподавателя): его пары до конца семестра. */
async function teacherCalendar(ctx: BotContext, alarm: number | null): Promise<{ ics: string; count: number; to: string; name: string } | null> {
  const ref = ownTeacherRef(ctx.user);
  if (!ref) return null;
  const profile = await loadProfile(ctx.deps, ref).catch(() => null);
  if (!profile) return null;
  const { from, to } = calendarWindow(ctx.deps.service);
  const loaded = await profileLessons(ctx.deps, profile, from, to);
  if (loaded.failed) return null;
  const name = shortName(loaded.fullName ?? profile.name);
  const ics = buildIcs({ name: `${name} — пары`, lessons: loaded.lessons, alarmMinutes: alarm });
  return { ics, count: loaded.lessons.filter((o) => o.status === "scheduled").length, to, name };
}

export function calendarKeyboard(ctx: BotContext): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (subscriptionsEnabled(ctx)) kb.text("🔗 Подписка: обновляется сама", "ics:sub").row();
  return kb.text("📎 Файл без напоминаний", "ics:0").row().text("📎 ⏰ за 15 мин", "ics:15").text("📎 ⏰ за 30 мин", "ics:30").text("📎 ✏️ Своё", "ics:own");
}

function alarmKeyboard(prefix: string): InlineKeyboard {
  return new InlineKeyboard().text("Без напоминаний", `${prefix}:0`).row().text("⏰ за 15 мин", `${prefix}:15`).text("⏰ за 30 мин", `${prefix}:30`).text("✏️ Своё", `${prefix}:own`);
}

/** «✏️ Своё»: напоминание за сколько угодно минут — от 1 до суток. */
export const MAX_ALARM_MIN = 1440;

/** Число минут из ввода или кнопки: 0 — без напоминания; вне 0…1440 — null. */
export function parseAlarm(raw: string): number | null {
  const m = /^\s*(\d{1,4})\s*(мин\p{L}*\.?)?\s*$/iu.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= MAX_ALARM_MIN ? n : null;
}

export async function offerCalendar(ctx: BotContext): Promise<void> {
  const group = needGroup(ctx);
  if (!group && !ctx.user.teacherMode) return void (await ctx.reply(groupRequiredText()));
  const lines = ["<b>📆 Пары в календарь телефона</b>", ""];
  if (subscriptionsEnabled(ctx)) {
    lines.push("<b>Подписка</b> — лучший вариант: телефон сам подтягивает расписание, переносы и отмены появляются в календаре без твоего участия, ничего не дублируется.", "");
  }
  lines.push("<b>Файл .ics</b> — все пары до конца семестра одним файлом. Открой его на телефоне и добавь события; можно с напоминанием-будильником.");
  if (!subscriptionsEnabled(ctx)) lines.push("", "<i>Расписание меняется, файл придётся обновлять: перед повторным импортом удали старые события (проще всего заводить для пар отдельный календарь).</i>");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: calendarKeyboard(ctx) });
}

calendarHandlers.command("calendar", offerCalendar);
calendarHandlers.hears(BTN.calendar, offerCalendar);
calendarHandlers.callbackQuery("ics:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await offerCalendar(ctx);
});

// ---- one-off file ----
async function sendCalendarFile(ctx: BotContext, alarm: number): Promise<void> {
  if (ctx.user.teacherMode) {
    const cal = await teacherCalendar(ctx, alarm > 0 ? alarm : null);
    if (!cal) return void (await ctx.reply("Не получилось собрать календарь: твоего расписания сейчас не видно (портал не ответил или тебя нет в справочнике). Попробуй позже."));
    const today = todayMsk();
    await ctx.replyWithDocument(new InputFile(Buffer.from(cal.ics, "utf8"), icsFileName(cal.name, today)), {
      caption: `${cal.name}: ${cal.count} ${plural(cal.count, "пара", "пары", "пар")} с ${fmtDDMM(today)} по ${fmtDDMM(cal.to)}${alarm ? `, напоминание за ${alarm} мин` : ""}.\n\nОткрой файл → «Добавить в календарь». Расписание меняется: раз в пару недель обновляй файл, перед этим удалив старые события.`,
    });
    return;
  }
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  const today = todayMsk();
  const { ics, count, to } = groupCalendar(ctx.deps.service, group, { subgroup: ctx.user.subgroup, alarmMinutes: alarm > 0 ? alarm : null, ppaDebts: ctx.deps.repo.ppaDebts(ctx.user.id, group.key) });
  const tips = subscriptionsEnabled(ctx) ? "Чтобы календарь обновлялся сам, выбери «Подписка» в /calendar." : "Расписание меняется: раз в пару недель обновляй файл, перед этим удалив старые события (удобно держать пары в отдельном календаре).";
  await ctx.replyWithDocument(new InputFile(Buffer.from(ics, "utf8"), icsFileName(group.title, today)), {
    caption: `${group.title}: ${count} ${plural(count, "пара", "пары", "пар")} с ${fmtDDMM(today)} по ${fmtDDMM(to)}${alarm ? `, напоминание за ${alarm} мин` : ""}.\n\nОткрой файл → «Добавить в календарь». ${tips}`,
  });
}

calendarHandlers.callbackQuery(/^ics:(\d{1,4})$/, async (ctx) => {
  const alarm = parseAlarm(ctx.match[1]!);
  if (alarm === null) return void (await ctx.answerCallbackQuery());
  if (!ctx.user.teacherMode && !needGroup(ctx)) return void (await ctx.answerCallbackQuery({ text: "Сначала выбери группу", show_alert: true }));
  await ctx.answerCallbackQuery({ text: "Собираю календарь…" });
  await sendCalendarFile(ctx, alarm);
});

/** «✏️ Своё» — и для файла, и для подписки: бот спрашивает число минут. */
calendarHandlers.callbackQuery(/^ics:(sub:)?own$/, async (ctx) => {
  const sub = !!ctx.match[1];
  if (sub && !subscriptionsEnabled(ctx)) return void (await ctx.answerCallbackQuery({ text: "Подписка пока не настроена", show_alert: true }));
  await ctx.answerCallbackQuery();
  setPending(ctx.deps, ctx.user.id, { kind: "cal-alarm", target: sub ? "sub" : "file" }, 5 * 60_000);
  await ctx.reply(`За сколько минут до пары напоминать? Напиши число от 1 до ${MAX_ALARM_MIN} — например <code>45</code> или <code>1440</code> (за сутки). Отмена: /cancel`, { parse_mode: "HTML" });
});

calendarHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (pending?.kind !== "cal-alarm" || ctx.msg.text.startsWith("/")) return next();
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  const alarm = parseAlarm(ctx.msg.text);
  // Ошибся — спрашиваем ещё раз, режим не сбрасываем.
  if (alarm === null || alarm === 0) return void (await ctx.reply(`Нужно число от 1 до ${MAX_ALARM_MIN} — сколько минут до пары. Например: 45. Отмена: /cancel`));
  clearPending(ctx.deps, ctx.user.id);
  if (pending.target === "sub") await sendSubscription(ctx, alarm);
  else await sendCalendarFile(ctx, alarm);
});

// ---- subscription (webcal) ----
calendarHandlers.callbackQuery("ics:sub", async (ctx) => {
  if (!subscriptionsEnabled(ctx)) return void (await ctx.answerCallbackQuery({ text: "Подписка пока не настроена", show_alert: true }));
  const group = needGroup(ctx);
  if (!group) return void (await ctx.answerCallbackQuery({ text: "Сначала выбери группу", show_alert: true }));
  await ctx.answerCallbackQuery();
  await ctx.reply("Напоминание перед каждой парой в самом календаре?", { reply_markup: alarmKeyboard("ics:sub") });
});

calendarHandlers.callbackQuery(/^ics:sub:(\d{1,4})$/, async (ctx) => {
  if (!subscriptionsEnabled(ctx)) return void (await ctx.answerCallbackQuery({ text: "Подписка пока не настроена", show_alert: true }));
  if (!needGroup(ctx)) return void (await ctx.answerCallbackQuery({ text: "Сначала выбери группу", show_alert: true }));
  const alarm = parseAlarm(ctx.match[1]!);
  if (alarm === null) return void (await ctx.answerCallbackQuery());
  await ctx.answerCallbackQuery();
  await sendSubscription(ctx, alarm);
});

async function sendSubscription(ctx: BotContext, alarm: number): Promise<void> {
  const group = needGroup(ctx);
  if (!group || !subscriptionsEnabled(ctx)) return void (await ctx.reply(group ? "Подписка пока не настроена." : groupRequiredText()));
  ctx.deps.repo.updateUser(ctx.user.id, { calAlarmMin: alarm > 0 ? alarm : null });
  const token = ctx.deps.repo.ensureCalToken(ctx.user.id);
  const base = publicBase(ctx.deps)!;
  const http = `${base}${calendarPath(token)}`;
  const webcal = http.replace(/^https?:\/\//, "webcal://");
  await ctx.reply(
    [
      `<b>🔗 Подписка на расписание ${esc(group.title)}</b>${ctx.user.subgroup ? ` (${ctx.user.subgroup} подгруппа)` : ""}${alarm ? `, напоминание за ${alarm} мин` : ""}`,
      "",
      `<code>${esc(http)}</code>`,
      "",
      "<b>iPhone:</b> Настройки → Приложения → Календарь → Учётные записи → Добавить → Другое → «Подписной календарь» → вставь ссылку. Или просто открой:",
      `<code>${esc(webcal)}</code>`,
      "",
      "<b>Android / Google Календарь:</b> на сайте calendar.google.com (с компьютера или в версии для ПК) слева «Другие календари» → «+» → «По URL» → вставь ссылку. Потом в приложении на телефоне: ☰ → Настройки → календарь группы (бывает под «Показать ещё») → включи «Синхронизация», иначе на телефоне его не видно.",
      "",
      "Ссылка личная и постоянная: сменишь группу или подгруппу в боте — подписка обновится сама. iPhone проверяет подписки раз в несколько часов, Google Календарь — раз в 12–24 ч.",
    ].join("\n"),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

// ---- "just the changes" file from «Изменения» ----
/**
 * Файл .ics только с изменениями группы. Общий для кнопки «📆 Файл изменений
 * в календарь» и ссылки с тем же текстом в подписи к альбому (/start ics_…).
 * Без файла — причина и стоит ли показать её всплывающим окном.
 */
export function changesIcs(ctx: BotContext, key: string): { file: InputFile; caption: string } | { error: string; alert: boolean } {
  const group = ctx.deps.service.group(key);
  if (!group) return { error: "Группа не найдена", alert: false };
  const own = ctx.user.groupKey === key;
  // Oldest first so the newest state of a lesson wins in the generated file.
  // Все актуальные — на них ссылается «…и ещё N» в «🔔 Изменения».
  const rows = ctx.deps.repo.activeEvents(key, todayMsk(), 200).slice().sort((a, b) => a.id - b.id);
  if (!rows.length) return { error: "Актуальных изменений уже нет", alert: true };
  const events: ChangeEvent[] = rows.map((r) => {
    const p = r.payload as { before?: ChangeEvent["before"]; after?: ChangeEvent["after"]; fields?: string[] };
    return { kind: r.kind as ChangeEvent["kind"], groupKey: r.groupKey, date: r.date, period: r.period, before: p.before, after: p.after, fields: p.fields };
  });
  const alarm = ctx.user.calAlarmMin;
  const { ics, live, cancelled } = changesCalendar(group, events, { subgroup: own ? ctx.user.subgroup : null, alarmMinutes: alarm });
  const sub = subscriptionsEnabled(ctx) ? "\n\nС подпиской (в /calendar) это не нужно: там всё меняется само." : "";
  return {
    file: new InputFile(Buffer.from(ics, "utf8"), icsFileName(group.title, todayMsk(), "_changes")),
    caption: `${group.title}: только изменения — обновить ${live} ${plural(live, "пару", "пары", "пар")}, снять ${cancelled} ${plural(cancelled, "пару", "пары", "пар")}.\n\nОткрой файл → «Добавить». Google-календарь заменит события с теми же парами; на iPhone изменённые пары добавятся, а отменённые придут помеченными «Отменено» — их можно удалить.${sub}`,
  };
}

calendarHandlers.callbackQuery(/^cics:(.+)$/, async (ctx) => {
  const res = changesIcs(ctx, ctx.match[1]!);
  if ("error" in res) return void (await ctx.answerCallbackQuery({ text: res.error, show_alert: res.alert }));
  await ctx.answerCallbackQuery({ text: "Собираю изменения…" });
  await ctx.replyWithDocument(res.file, { caption: res.caption });
});


