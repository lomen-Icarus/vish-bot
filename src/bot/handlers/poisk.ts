/**
 * «Сыск» — глобальный поиск студента.
 *
 * Включается переменной POISK=TRUE. При POISK=FALSE этот Composer вообще не
 * подключается к боту (см. src/bot/index.ts), поэтому раздела нет ни в
 * кнопках, ни в командах, ни в колбэках — нажатие старой кнопки просто ничего
 * не делает.
 *
 * Бот берёт ФИО из отдельного файла на хостинге (POISK_DB, в репозиторий он не
 * попадает), находит группу и подгруппу человека и показывает, где он должен
 * быть сейчас по расписанию, плюс расписание на день с обычными кнопками.
 * Это расписание группы, а не слежка: ходит ли человек на пары, бот не знает.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, isMenuText } from "../keyboards.js";
import { dayView, weekView } from "../views.js";
import { esc, clampHtml } from "../../schedule/format.js";
import { courseFor, findGroup, logicalKeyFor, parseGroupName, type LogicalGroup } from "../../schedule/groups.js";
import type { Occurrence } from "../../schedule/model.js";
import { lessonTypeLabel } from "../../schedule/model.js";
import type { StudentRecord } from "../../students/directory.js";
import { addDays, fmtDDMM, fmtHHMM, mondayOf, todayMsk, wallClock, type LocalDate } from "../../time.js";

export const poiskHandlers = new Composer<BotContext>();

export const POISK_INTRO = [
  "🕵️ <b>Глобальный поиск студента</b>",
  "",
  "Пишешь ФИО — бот находит человека в базе ВИШ, определяет его группу и подгруппу и показывает, <b>где он должен быть прямо сейчас</b> по расписанию: пара, аудитория, до скольки. Плюс его расписание на день с обычными кнопками «вчера / завтра / неделя».",
  "",
  "Важно: это расписание его группы, а не слежка. Ходит ли человек на пары на самом деле, бот не знает 🙂",
  "Из базы берутся только ФИО, группа и подгруппа — ни телефона, ни адреса, ни оценок там для бота нет. Каждый поиск записывается в журнал.",
  "",
  "Напиши фамилию (можно с именем): <code>Иванов Иван</code>. Отмена: /cancel",
].join("\n");

/** Подпись под приглашением: сколько людей в базе и каких курсов там нет. */

function limitFor(ctx: BotContext): number {
  return ctx.deps.config.POISK_DAILY_LIMIT;
}

async function startPoisk(ctx: BotContext): Promise<void> {
  const dir = ctx.deps.students;
  if (!dir || !dir.ready()) {
    await ctx.reply("Поиск людей пока не работает: база студентов не загружена. Админ кладёт её файлом на сервер (POISK_DB).");
    return;
  }
  const limit = limitFor(ctx);
  if (limit > 0 && !ctx.isAdmin && ctx.deps.repo.poiskUsage(ctx.user.id, todayMsk()) >= limit) {
    await ctx.reply(`На сегодня лимит поисков людей исчерпан (${limit} в день). Завтра снова можно.`);
    return;
  }
  setPending(ctx.deps, ctx.user.id, { kind: "poisk" }, 5 * 60_000);
  const note = coverageNote(ctx);
  await ctx.reply(`${POISK_INTRO}\n\n<i>В базе ${dir.count()} чел. ${note}</i>`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖️ Отмена", "poisk:cancel") });
}

poiskHandlers.command("poisk", startPoisk);
poiskHandlers.hears(BTN.whereStudent, startPoisk);
poiskHandlers.callbackQuery("poisk:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startPoisk(ctx);
});
poiskHandlers.callbackQuery("poisk:cancel", async (ctx) => {
  clearPending(ctx.deps, ctx.user.id);
  await ctx.answerCallbackQuery({ text: "Отменено" });
  try {
    await ctx.editMessageText("Поиск людей отменён.");
  } catch {
    /* ignore */
  }
});

/**
 * Какие курсы вообще есть в реестре. Реестр присылают не целиком (например,
 * первого курса в нём нет), и честнее сказать это сразу, чем «человек не найден».
 */
function coverageNote(ctx: BotContext): string {
  const dir = ctx.deps.students;
  if (!dir) return "";
  const courses = new Set<number>();
  for (const title of dir.groupTitles()) {
    const parsed = parseGroupName(title);
    if (parsed) courses.add(courseFor(parsed.intake, ctx.deps.service.academicYear));
  }
  const list = [...courses].filter((c) => c >= 1 && c <= 6).sort((a, b) => a - b);
  if (!list.length) return "";
  return `В реестре только ${list.join(", ")} курс${list.length > 1 ? "ы" : ""} — кого нет в этом списке, того бот не найдёт.`;
}

/**
 * Группа человека в расписании ВИШ. Реестр пишет её по-своему («ВИШ-11-23(ЭиЭА)»,
 * «ВИШ-12-23иот (11.03.04)»), поэтому сначала сравниваем логические ключи.
 * Если под одним номером в расписании несколько РАЗНЫХ групп (ВИШ-11-23 бывает
 * и ЭиЭА, и РЗиАЭС), угадывать нельзя: покажем чужие пары, и никто не заметит.
 */
function groupOf(ctx: BotContext, student: StudentRecord): { group: LogicalGroup | null; ambiguous: LogicalGroup[] } {
  const groups = ctx.deps.service.groups();
  const exact = groups.find((g) => g.key === logicalKeyFor(student.groupTitle));
  if (exact) return { group: exact, ambiguous: [] };
  const list = findGroup(groups, student.groupTitle);
  return list.length === 1 ? { group: list[0]!, ambiguous: [] } : { group: null, ambiguous: list };
}

function studentTitle(student: StudentRecord): string {
  return `🕵️ <b>${esc(student.name)}</b>\nГруппа: <b>${esc(student.groupTitle)}</b>${student.subgroup ? ` · ${student.subgroup} подгруппа` : ""}`;
}

const place = (o: Occurrence): string => (o.isDistance ? "дистанционно 💻" : o.room ? `ауд. ${esc(o.room)}` : "аудитория не указана");

/** Пара одной строкой; подгруппу называем, когда она неизвестна и вариантов несколько. */
function lessonLine(o: Occurrence, showSubgroup: boolean): string {
  const sub = showSubgroup && o.subgroup ? `${o.subgroup} подгр. — ` : "";
  return `${sub}<b>${esc(o.subject)}</b> (${lessonTypeLabel(o.type)}), ${place(o)}`;
}

/**
 * Где человек должен быть сейчас: идёт пара, перерыв до следующей или свободен.
 * Если в реестре нет подгруппы, у одной и той же пары бывает два разных места —
 * тогда честно показываем оба варианта, а не первый попавшийся.
 */
function whereNow(lessons: Occurrence[], date: LocalDate, today: LocalDate, subgroup: number | null): string {
  const clock = wallClock();
  // «moved» — это опустевший слот перенесённой пары, человека там нет.
  const live = lessons.filter((o) => o.status !== "moved");
  const unknownSubgroup = subgroup == null;
  const slots = (list: Occurrence[]): number => new Set(list.map((o) => o.slot ?? o.start ?? 0)).size;
  if (date !== today) {
    if (!live.length) return `📍 ${fmtDDMM(date)}: пар нет.`;
    const n = slots(live);
    const first = live[0]!;
    return `📍 ${fmtDDMM(date)}: ${n} пар${n === 1 ? "а" : n < 5 ? "ы" : ""}, начало в ${first.start != null ? fmtHHMM(first.start) : "?"}.`;
  }
  if (!live.length) return "📍 Сегодня пар нет — по расписанию человек свободен.";
  const now = clock.minutes;
  const sameSlot = (a: Occurrence, b: Occurrence): boolean => (a.slot ?? a.start) === (b.slot ?? b.start);
  const current = live.filter((o) => o.start != null && o.end != null && now >= o.start && now <= o.end);
  const note = unknownSubgroup && current.length > 1 ? "\n<i>Подгруппа в реестре не указана, поэтому оба варианта.</i>" : "";
  if (current.length) {
    const end = current[0]!.end;
    const where = current.map((o) => lessonLine(o, unknownSubgroup)).join("\n   ");
    return `📍 Сейчас (${fmtHHMM(now)}) должен быть здесь: ${current.length > 1 ? "\n   " : ""}${where}${end != null ? `\n   до ${fmtHHMM(end)}` : ""}${note}`;
  }
  const upcoming = live.filter((o) => o.start != null && o.start > now);
  if (upcoming.length) {
    const next = upcoming.filter((o) => sameSlot(o, upcoming[0]!));
    const wait = upcoming[0]!.start! - now;
    const where = next.map((o) => lessonLine(o, unknownSubgroup)).join("\n   ");
    const many = unknownSubgroup && next.length > 1 ? "\n<i>Подгруппа в реестре не указана, поэтому оба варианта.</i>" : "";
    return `📍 Сейчас (${fmtHHMM(now)}) пары нет. Ближайшая через ${wait < 60 ? `${wait} мин` : `${Math.round(wait / 60)} ч`} — в ${fmtHHMM(upcoming[0]!.start!)}: ${next.length > 1 ? "\n   " : ""}${where}${many}`;
  }
  const last = live[live.length - 1]!;
  return `📍 Сейчас (${fmtHHMM(now)}) пар уже нет: на сегодня закончились${last.end != null ? ` в ${fmtHHMM(last.end)}` : ""}.`;
}

function studentDayNav(student: StudentRecord, date: LocalDate): InlineKeyboard {
  return new InlineKeyboard()
    .text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `pos:${student.id}:${addDays(date, -1)}`)
    .text(`${fmtDDMM(addDays(date, 1))} ▶️`, `pos:${student.id}:${addDays(date, 1)}`)
    .row()
    .text("🗓 Неделя", `posw:${student.id}:${date}`)
    .text("🔎 Другой человек", "poisk:menu");
}

async function showStudentDay(ctx: BotContext, student: StudentRecord, date: LocalDate, opts: { edit?: boolean; group?: LogicalGroup } = {}): Promise<void> {
  const edit = opts.edit === true;
  const resolved = opts.group ? { group: opts.group, ambiguous: [] as LogicalGroup[] } : groupOf(ctx, student);
  const group = resolved.group;
  if (!group) {
    // Заочные группы (ОЗВИШ) портал в боте не ведёт — это не ошибка поиска.
    const kb = new InlineKeyboard();
    let why: string;
    if (resolved.ambiguous.length) {
      why = `В расписании под «${esc(student.groupTitle)}» несколько разных групп. В реестре не написано, какая именно — выбери:`;
      for (const g of resolved.ambiguous) kb.text(`📅 ${g.title}`, `posg:${student.id}:${g.key}`).row();
    } else {
      why = /^ОЗ/i.test(student.groupTitle) ? "Это заочная группа: её расписание бот не показывает." : "Такой группы нет в расписании ВИШ (возможно, человек уже выпустился или перевёлся).";
    }
    kb.text("🔎 Другой человек", "poisk:menu");
    await ctx.reply(`${studentTitle(student)}\n\n${why}`, { parse_mode: "HTML", reply_markup: kb });
    return;
  }
  const { text, lessons } = dayView(ctx.deps, group, date, student.subgroup);
  const body = clampHtml(`${studentTitle(student)}\n\n${whereNow(lessons, date, todayMsk(), student.subgroup)}\n\n${text}`);
  const kb = studentDayNav(student, date);
  if (edit) {
    try {
      await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
}

async function showStudentWeek(ctx: BotContext, student: StudentRecord, anyDate: LocalDate, edit = false): Promise<void> {
  const { group } = groupOf(ctx, student);
  if (!group) return void (await ctx.reply("Группа этого человека не найдена в расписании ВИШ.", { reply_markup: new InlineKeyboard().text("🔎 Другой человек", "poisk:menu") }));
  const monday = mondayOf(anyDate);
  const { text } = weekView(ctx.deps, group, monday, student.subgroup);
  const body = clampHtml(`${studentTitle(student)}\n\n${text}`);
  const kb = new InlineKeyboard()
    .text("◀️ пред.", `posw:${student.id}:${addDays(monday, -7)}`)
    .text("след. ▶️", `posw:${student.id}:${addDays(monday, 7)}`)
    .row()
    // День открытой недели, а не «сегодня»: иначе кнопка уводит с той недели, которую смотрят.
    .text("📅 День", `pos:${student.id}:${monday}`)
    .text("🔎 Другой человек", "poisk:menu");
  if (edit) {
    try {
      await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
}

poiskHandlers.callbackQuery(/^pos:([A-Za-z0-9_-]+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const student = ctx.deps.students?.get(ctx.match[1]!);
  if (!student) return void (await ctx.reply("Человек не найден — база обновилась. Поищи заново."));
  await showStudentDay(ctx, student, ctx.match[2]!, { edit: true });
});

poiskHandlers.callbackQuery(/^posw:([A-Za-z0-9_-]+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const student = ctx.deps.students?.get(ctx.match[1]!);
  if (!student) return void (await ctx.reply("Человек не найден — база обновилась. Поищи заново."));
  await showStudentWeek(ctx, student, ctx.match[2]!, true);
});

poiskHandlers.callbackQuery(/^pop:([A-Za-z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const student = ctx.deps.students?.get(ctx.match[1]!);
  if (!student) return void (await ctx.reply("Человек не найден — база обновилась. Поищи заново."));
  // В журнале должен стоять тот, кого реально открыли, а не первый из подсказок.
  ctx.deps.repo.markPoiskChoice(ctx.user.id, todayMsk(), student.id);
  await showStudentDay(ctx, student, todayMsk());
});

// Выбор конкретной группы, когда под одним номером их несколько.
poiskHandlers.callbackQuery(/^posg:([A-Za-z0-9_-]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const student = ctx.deps.students?.get(ctx.match[1]!);
  const group = ctx.deps.service.group(ctx.match[2]!);
  if (!student || !group) return void (await ctx.reply("Не нашёл — поищи заново."));
  await showStudentDay(ctx, student, todayMsk(), { group });
});

poiskHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "poisk") return next();
  if (ctx.msg.text.startsWith("/")) return next();
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  clearPending(ctx.deps, ctx.user.id);
  const dir = ctx.deps.students;
  if (!dir) return void (await ctx.reply("Поиск людей выключен."));
  const query = ctx.msg.text.trim().slice(0, 100);
  const day = todayMsk();
  const limit = limitFor(ctx);
  if (limit > 0 && !ctx.isAdmin && ctx.deps.repo.poiskUsage(ctx.user.id, day) >= limit) {
    return void (await ctx.reply(`На сегодня лимит поисков людей исчерпан (${limit} в день).`));
  }
  const hits = dir.search(query, 8);
  const exact = hits.filter((h) => !h.fuzzy);
  // Один точный однофамилец — открываем сразу; «Кузнецов Пётр» тоже, если он
  // заметно впереди остальных (у кого-то совпало только отчество).
  const clear = exact.length === 1 || (exact.length > 1 && exact[0]!.score - exact[1]!.score >= 3);
  // В журнале — тот, кого реально открыли; при списке кандидатов его уточнит
  // нажатие кнопки (markPoiskChoice), лишний раз лимит на это не тратится.
  ctx.deps.repo.logPoisk(ctx.user.id, day, query, clear ? (exact[0]?.student.id ?? null) : null);
  if (!hits.length) {
    const note = coverageNote(ctx);
    return void (await ctx.reply(`Никого похожего на «${esc(query)}» в базе нет. Проверь фамилию — можно одну, без имени.${note ? `\n\n${note}` : ""}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔎 Попробовать ещё раз", "poisk:menu") }));
  }
  if (clear) return showStudentDay(ctx, exact[0]!.student, day);

  const kb = new InlineKeyboard();
  for (const h of hits.slice(0, 8)) kb.text(`${h.student.name} · ${h.student.groupTitle}`.slice(0, 60), `pop:${h.student.id}`).row();
  kb.text("✖️ Отмена", "poisk:cancel");
  await ctx.reply(exact.length ? "Кого показать?" : `Точного совпадения с «${esc(query)}» нет. Может быть, кто-то из них?`, { parse_mode: "HTML", reply_markup: kb });
});
