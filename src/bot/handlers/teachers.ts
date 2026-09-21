import { Composer, InlineKeyboard, InputFile } from "grammy";
import { createHash } from "node:crypto";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, isMenuText, teacherDayNav, teacherWeekNav } from "../keyboards.js";
import { clampHtml, esc, formatDay, formatWebinarTeacher, formatWeek } from "../../schedule/format.js";
import type { LogicalGroup } from "../../schedule/groups.js";
import type { Occurrence } from "../../schedule/model.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../../time.js";
import { teacherMapKey, type TeacherRef } from "../../portal/teachers.js";
import type { WebinarTeacher } from "../../portal/webinars.js";
import { logger } from "../../logger.js";

export const teacherHandlers = new Composer<BotContext>();

const UNAVAILABLE = "Расписание преподавателей портал показывает только авторизованным. Попроси админа добавить учётку портала в настройки бота (PORTAL_LOGIN / PORTAL_PASSWORD), и раздел заработает.";

/**
 * Callback key for a teacher known only from the webinar page (no portal id).
 * A digest, not the name: callback_data is limited to 64 bytes and two long
 * Cyrillic surnames would otherwise share a truncated prefix.
 */
export function webinarKey(name: string): string {
  return `wtc:${createHash("sha1").update(name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()).digest("base64url").slice(0, 16)}`;
}

function findWebinarTeacher(ctx: BotContext, key: string): WebinarTeacher | null {
  return (ctx.deps.webinars?.teachers() ?? []).find((t) => webinarKey(t.name) === key) ?? null;
}

/** Same person? Surnames repeat, so initials decide. */
function samePerson(a: string, b: string): boolean {
  const parts = (x: string) =>
    x
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[\s.]+/)
      .filter(Boolean);
  const [pa, pb] = [parts(a), parts(b)];
  if (!pa.length || !pb.length || pa[0] !== pb[0]) return false;
  const initials = (p: string[]) => p.slice(1).map((w) => w[0]).join("");
  const [ia, ib] = [initials(pa), initials(pb)];
  return !ia || !ib || ia === ib;
}

async function showWebinarTeacher(ctx: BotContext, t: WebinarTeacher): Promise<void> {
  const webinars = ctx.deps.webinars;
  const upcoming = webinars ? webinars.upcoming(t, 8) : [];
  const text = clampHtml(formatWebinarTeacher(t, upcoming, false));
  const kb = new InlineKeyboard().text("🔎 Другой преподаватель", "t:search");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, ""), { reply_markup: kb }));
}

/**
 * Карточка преподавателя из карты: по id, а если его ещё не обходили — по имени
 * (так находятся преподаватели дистанта, у которых id нет вовсе).
 */
function mapRow(ctx: BotContext, teacherId: number | null, name: string) {
  return (teacherId != null ? ctx.deps.repo.teacherMapById(teacherId) : null) ?? ctx.deps.repo.teacherMapByKey(teacherMapKey(null, name));
}

/**
 * «(ВИШ)» рядом с фамилией. В университете есть полные тёзки, и без пометки
 * невозможно понять, кто из них ведёт у нашей школы.
 */
function vishTag(ctx: BotContext, teacherId: number | null, name: string): string {
  return mapRow(ctx, teacherId, name)?.vish ? " (ВИШ)" : "";
}

/**
 * Фото преподавателя — ПОСЛЕДНИМ сообщением, уже после расписания: наверх
 * никто не листает, а так и картинка видна, и расписание прямо над ней.
 */
async function sendTeacherPhoto(ctx: BotContext, t: TeacherRef, fullName: string | null): Promise<void> {
  const teachers = ctx.deps.teachers;
  if (!teachers) return;
  try {
    const photo = await teachers.photo(t.id);
    const row = photo.row;
    const caption = [`👨‍🏫 <b>${esc(fullName ?? t.name)}</b>${row?.vish ? " (ВИШ)" : ""}`, [row?.degree, row?.department].filter(Boolean).map((x) => esc(String(x))).join(" · ")].filter(Boolean).join("\n");
    if (photo.fileId) {
      await ctx.replyWithPhoto(photo.fileId, { caption, parse_mode: "HTML", disable_notification: true });
      return;
    }
    if (!photo.bytes) return;
    const sent = await ctx.replyWithPhoto(new InputFile(photo.bytes, `teacher-${t.id}.jpg`), { caption, parse_mode: "HTML", disable_notification: true });
    // Второй раз качать с портала незачем: Telegram отдаст ту же картинку по file_id.
    const fileId = sent.photo?.[sent.photo.length - 1]?.file_id;
    if (fileId && photo.key) ctx.deps.repo.setTeacherPhotoFileId(photo.key, fileId);
  } catch (err) {
    logger.debug({ err: String(err), teacher: t.id }, "teacher photo send failed");
  }
}

function pseudoGroup(t: TeacherRef, fullName: string | null): LogicalGroup {
  return { key: `teacher:${t.id}`, title: fullName ?? t.name, prefix: "", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] };
}

async function askName(ctx: BotContext): Promise<void> {
  if (!ctx.deps.teachers && !ctx.deps.webinars) return void (await ctx.reply(UNAVAILABLE));
  setPending(ctx.deps, ctx.user.id, { kind: "teacher" }, 3 * 60_000);
  const limited = !ctx.deps.teachers ? "\n\nПока без учётки портала бот знает преподавателей только по дистанционным парам: очные портал показывает лишь авторизованным." : "";
  await ctx.reply(`Напиши фамилию преподавателя, можно с именем или инициалами в любом порядке: <code>Иванова</code>, <code>Дарья Иванова</code>, <code>Иванова Д.А.</code> Отмена: /cancel${limited}`, { parse_mode: "HTML" });
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
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  clearPending(ctx.deps, ctx.user.id);
  const teachers = ctx.deps.teachers;
  const query = ctx.msg.text;
  await ctx.replyWithChatAction("typing");
  const scored = teachers ? await teachers.searchScored(query) : [];
  const found = scored.map((x) => x.ref);
  // Teachers of online lessons are readable without a portal account; keep them as a fallback.
  const webinarHits = (ctx.deps.webinars?.searchScored(query, 5) ?? []).filter((w) => !found.some((t) => samePerson(t.name, w.teacher.name)));
  const fromWebinars = webinarHits.map((w) => w.teacher);
  if (!found.length && !fromWebinars.length) {
    const err = teachers?.lastError();
    const hint = err && ctx.isAdmin ? `\n\n<i>Админу: последняя ошибка портала — ${esc(err)}</i>` : "";
    const noAccount = !teachers ? "\n\nСейчас бот знает только преподавателей дистанционных пар: полный справочник портал отдаёт лишь авторизованным." : "";
    return void (await ctx.reply(`Никого не нашёл по «${esc(query)}» — даже с поправкой на опечатки. Попробуй одну фамилию без имени или первые буквы фамилии; имя и фамилию можно в любом порядке.${noAccount}${hint}`, { parse_mode: "HTML" }));
  }
  // Совпало только с опечатками — не открываем чужое расписание молча, а спрашиваем.
  // Без учётки портала scored пуст, поэтому судим и по преподавателям дистанта.
  const guess = [...scored, ...webinarHits].every((x) => x.fuzzy);
  if (!guess && found.length === 1 && !fromWebinars.length) return showTeacherDay(ctx, found[0]!, todayMsk());
  if (!guess && !found.length && fromWebinars.length === 1) return showWebinarTeacher(ctx, fromWebinars[0]!);
  const kb = new InlineKeyboard();
  // Тёзки встречаются, поэтому «наши» помечены и идут первыми.
  const ranked = [...found].sort((a, b) => Number(!!vishTag(ctx, b.id, b.name)) - Number(!!vishTag(ctx, a.id, a.name)));
  for (const t of ranked) kb.text(`${t.name}${vishTag(ctx, t.id, t.name)}`, `t:${t.id}`).row();
  for (const t of fromWebinars) kb.text(`${t.name} (ВИШ, дистант)`, webinarKey(t.name)).row();
  kb.text("🔎 Искать другого", "t:search");
  await ctx.reply(guess ? `Точного совпадения с «${esc(query)}» нет. Может быть, кто-то из них?` : "Кого показать?", { parse_mode: "HTML", reply_markup: kb });
});

teacherHandlers.callbackQuery(/^wtc:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const t = findWebinarTeacher(ctx, `wtc:${ctx.match[1]!}`);
  if (!t) return void (await ctx.reply("Преподаватель не найден, поищи заново: " + BTN.teachers));
  await showWebinarTeacher(ctx, t);
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

teacherHandlers.callbackQuery(/^twf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const t = await ctx.deps.teachers?.byId(id);
  const name = t?.name ?? ctx.deps.repo.teacherMapById(id)?.name ?? `#${id}`;
  const following = ctx.deps.repo.toggleWatchTeacher(ctx.user.id, id, name);
  await ctx.answerCallbackQuery({
    text: following ? "Слежу: пришлю его расписание вечером и за 2 часа до первой пары" : "Больше не слежу за этим преподавателем",
    show_alert: following,
  });
  try {
    const msg = ctx.callbackQuery.message;
    const data = msg && "reply_markup" in msg ? msg.reply_markup : undefined;
    // Перерисовываем ту же клавиатуру, только с новой надписью на кнопке.
    if (data?.inline_keyboard) {
      const rows = data.inline_keyboard.map((row) =>
        row.map((b) => ("callback_data" in b && b.callback_data === `twf:${id}` ? { ...b, text: following ? "🔕 Не следить за преподом" : "👁 Следить за преподом" } : b)),
      );
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows } });
    }
  } catch {
    /* сообщение могло устареть */
  }
});

async function showTeacherDay(ctx: BotContext, t: TeacherRef, date: LocalDate, edit = false): Promise<void> {
  const teachers = ctx.deps.teachers!;
  try {
    const { lessons, fullName } = await teachers.lessons(t, date, date);
    const title = `${fullName ?? t.name}${vishTag(ctx, t.id, fullName ?? t.name)}`;
    const text = formatDay(pseudoGroup(t, title), date, lessons, ctx.deps.service.weekInfo(date), todayMsk(), { now: wallClock() });
    const kb = teacherDayNav(t.id, date, { following: ctx.deps.repo.watchesTeacher(ctx.user.id, t.id) });
    if (edit) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
        return;
      } catch (err) {
        if (String(err).includes("message is not modified")) return;
      }
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    if (!edit) await sendTeacherPhoto(ctx, t, fullName);
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
    const text = formatWeek(pseudoGroup(t, `${fullName ?? t.name}${vishTag(ctx, t.id, fullName ?? t.name)}`), monday, byDate, ctx.deps.service.weekInfo(monday), todayMsk());
    const kb = teacherWeekNav(t.id, monday, { following: ctx.deps.repo.watchesTeacher(ctx.user.id, t.id) });
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
