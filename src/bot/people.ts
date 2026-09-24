/**
 * Люди в боте: одна карточка, одни кнопки, один список кандидатов — для
 * преподавателя и для студента, откуда бы его ни открыли (кнопка
 * «👨‍🏫 Преподаватели», «Где студент», «🔍 Поиск», ответ ИИ, старые кнопки).
 *
 *   ◀️ 23.09 | 25.09 ▶️
 *   🗓 Неделя | 🔎 Найти другого
 *   👁 Следить за преподом   /   📅 Вся группа 12-23
 *
 * Третья строка своя у каждого, но место и вид — одинаковые.
 */
import { Composer, InlineKeyboard, InputFile } from "grammy";
import type { BotContext } from "./context.js";
import { clearPending, setPending, takePending } from "./context.js";
import { BTN, groupCb, isMenuText } from "./keyboards.js";
import { esc } from "../schedule/format.js";
import { courseFor, parseGroupName } from "../schedule/groups.js";
import { addDays, fmtDDMM, mondayOf, todayMsk, type LocalDate } from "../time.js";
import { logger } from "../logger.js";
import { chooseStudentGroup, loadProfile, personDayView, personWeekView, studentsEnabled, type PersonProfile } from "../people/profile.js";
import { parseRefKey, refKey, webinarNameKey, type PersonRef } from "../people/ref.js";
import { clearHit, hitLabel, searchPeople, studentSearchAllowed, type PeopleScope, type PersonHit } from "../people/search.js";

export const peopleHandlers = new Composer<BotContext>();

/** Callback_data «Найти другого» и списка кандидатов: t — преподаватели, s — студенты, a — все. */
const SCOPE_CODE: Record<PeopleScope, string> = { teacher: "t", student: "s", all: "a" };
const CODE_SCOPE: Record<string, PeopleScope> = { t: "teacher", s: "student", a: "all" };

const UNAVAILABLE = "Расписание преподавателей портал показывает только авторизованным. Попроси админа добавить учётку портала в настройки бота (PORTAL_LOGIN / PORTAL_PASSWORD), и раздел заработает.";

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

/**
 * Какие курсы вообще есть в реестре. Реестр присылают не целиком (например,
 * первого курса в нём нет), и честнее сказать это сразу, чем «человек не найден».
 */
export function coverageNote(ctx: BotContext): string {
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

function scopeOfProfile(p: PersonProfile): PeopleScope {
  return p.role === "student" ? "student" : "teacher";
}

/** «ВИШ-12-23» → «12-23» для подписи кнопки. */
function groupShort(title: string): string {
  return title.replace(/^ВИШ-/, "").replace(/\s*\((.*?)\)\s*$/, " $1");
}

/** Кнопки под карточкой человека (день или неделя). */
export function personKeyboard(ctx: BotContext, p: PersonProfile, date: LocalDate, mode: "day" | "week"): InlineKeyboard {
  const key = refKey(p.ref);
  const other = `ppf:${SCOPE_CODE[scopeOfProfile(p)]}`;
  const kb = new InlineKeyboard();
  if (mode === "day") {
    // Без «сегодня» между стрелками: её читают как дату, на которой стоишь.
    kb.text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `pp:${key}:${addDays(date, -1)}`).text(`${fmtDDMM(addDays(date, 1))} ▶️`, `pp:${key}:${addDays(date, 1)}`).row();
    kb.text("🗓 Неделя", `ppw:${key}:${date}`).text("🔎 Найти другого", other).row();
  } else {
    const monday = mondayOf(date);
    kb.text("◀️ пред.", `ppw:${key}:${addDays(monday, -7)}`).text("след. ▶️", `ppw:${key}:${addDays(monday, 7)}`).row();
    // День открытой недели, а не «сегодня»: иначе кнопка уводит с той недели, которую смотрят.
    kb.text("📅 День", `pp:${key}:${monday}`).text("🔎 Найти другого", other).row();
  }
  if (p.ref.kind === "teacher") kb.text(ctx.deps.repo.watchesTeacher(ctx.user.id, p.ref.id) ? "🔕 Не следить за преподом" : "👁 Следить за преподом", `twf:${p.ref.id}`);
  else if (p.role === "student" && p.group) kb.text(`📅 Вся группа ${groupShort(p.group.title)}`, groupCb("pdn", p.group.key, mode === "day" ? date : mondayOf(date)));
  return kb;
}

/** Студент, у которого под одним номером несколько групп: выбор группы. */
function groupChoiceKeyboard(p: PersonProfile): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (p.ref.kind === "student") for (const g of p.ambiguous ?? []) kb.text(`📅 ${g.title}`, groupCb(`ppg:${p.ref.id}`, g.key)).row();
  return kb.text("🔎 Найти другого", `ppf:${SCOPE_CODE.student}`);
}

function isTextMessage(ctx: BotContext): boolean {
  const m = ctx.callbackQuery?.message;
  return !!m && !("photo" in m && m.photo) && !("document" in m && m.document);
}

/**
 * Открыть человека. `edit` — листаем карточку на месте (стрелки, «Неделя»),
 * иначе новое сообщение, а у преподавателя с учёткой следом приходит фото.
 */
export async function showPerson(ctx: BotContext, ref: PersonRef, date: LocalDate, opts: { mode?: "day" | "week"; edit?: boolean } = {}): Promise<boolean> {
  const mode = opts.mode ?? "day";
  if (ref.kind === "student" && !studentsEnabled(ctx.deps)) return false;
  let p: PersonProfile | null;
  try {
    p = await loadProfile(ctx.deps, ref, ctx.user.id);
  } catch (err) {
    logger.warn({ err: String(err) }, "people: profile failed");
    p = null;
  }
  if (!p) {
    await ctx.reply(ref.kind === "student" ? "Человек не найден — база обновилась. Поищи заново." : "Преподаватель не найден, поищи заново: " + BTN.teachers);
    return false;
  }
  const view = mode === "day" ? await personDayView(ctx.deps, p, date, ctx.user) : await personWeekView(ctx.deps, p, date, ctx.user);
  const kb = view.needsGroup ? groupChoiceKeyboard(p) : personKeyboard(ctx, p, date, mode);
  if (opts.edit && isTextMessage(ctx)) {
    try {
      await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: kb });
      return true;
    } catch (err) {
      if (String(err).includes("message is not modified")) return true;
      logger.debug({ err: String(err) }, "people: edit failed, sending a new card");
    }
  }
  await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: kb });
  if (!opts.edit && p.ref.kind === "teacher" && !view.failed) await sendTeacherPhoto(ctx, p);
  return true;
}

/**
 * Фото преподавателя — ПОСЛЕДНИМ сообщением, уже после расписания: наверх
 * никто не листает, а так и картинка видна, и расписание прямо над ней.
 */
async function sendTeacherPhoto(ctx: BotContext, p: PersonProfile): Promise<void> {
  const teachers = ctx.deps.teachers;
  if (!teachers || p.ref.kind !== "teacher") return;
  const id = p.ref.id;
  try {
    const photo = await teachers.photo(id);
    const row = photo.row;
    const caption = [`👨‍🏫 <b>${esc(row?.name ?? p.name)}</b>${p.vish || row?.vish ? " (ВИШ)" : ""}`, [row?.degree, row?.department].filter(Boolean).map((x) => esc(String(x))).join(" · ")].filter(Boolean).join("\n");
    if (photo.fileId) {
      try {
        await ctx.replyWithPhoto(photo.fileId, { caption, parse_mode: "HTML", disable_notification: true });
        return;
      } catch (err) {
        // file_id живёт внутри одного бота: после смены токена он перестаёт
        // работать, и фото пропало бы навсегда. Забываем и качаем заново.
        logger.debug({ err: String(err), teacher: id }, "stale photo file_id, refetching");
        teachers.forgetPhotoFileId(photo.key);
        const fresh = await teachers.photo(id);
        if (!fresh.bytes) return;
        const again = await ctx.replyWithPhoto(new InputFile(fresh.bytes, `teacher-${id}.jpg`), { caption, parse_mode: "HTML", disable_notification: true });
        const fileId = again.photo?.[again.photo.length - 1]?.file_id;
        if (fileId) ctx.deps.repo.setTeacherPhotoFileId(fresh.key, fileId);
        return;
      }
    }
    if (!photo.bytes) return;
    const sent = await ctx.replyWithPhoto(new InputFile(photo.bytes, `teacher-${id}.jpg`), { caption, parse_mode: "HTML", disable_notification: true });
    // Второй раз качать с портала незачем: Telegram отдаст ту же картинку по file_id.
    const fileId = sent.photo?.[sent.photo.length - 1]?.file_id;
    if (fileId && photo.key) ctx.deps.repo.setTeacherPhotoFileId(photo.key, fileId);
  } catch (err) {
    logger.debug({ err: String(err), teacher: id }, "teacher photo send failed");
  }
}

/**
 * Кнопки с кандидатами. Преподаватели ВИШ — ниже остальных, ближе к полю
 * ввода: туда и смотрят, и жмут, а тёзки из других институтов — выше.
 */
export function candidatesKeyboard(hits: PersonHit[], scope: PeopleScope): InlineKeyboard {
  const teachers = hits.filter((h) => h.role === "teacher").sort((a, b) => Number(a.vish) - Number(b.vish));
  const students = hits.filter((h) => h.role === "student");
  const kb = new InlineKeyboard();
  for (const h of [...teachers, ...students]) kb.text(hitLabel(h), `ppo:${refKey(h.ref)}`).row();
  return kb.text("🔎 Искать другого", `ppf:${SCOPE_CODE[scope]}`);
}

/** Приглашение к поиску: что писать и где искать. */
export async function promptPeople(ctx: BotContext, scope: PeopleScope): Promise<void> {
  const deps = ctx.deps;
  if (scope === "teacher") {
    if (!deps.teachers && !deps.webinars) return void (await ctx.reply(UNAVAILABLE));
    setPending(deps, ctx.user.id, { kind: "teacher" }, 3 * 60_000);
    const limited = !deps.teachers ? "\n\nПока без учётки портала бот знает преподавателей только по дистанционным парам: очные портал показывает лишь авторизованным." : "";
    await ctx.reply(`Напиши фамилию преподавателя, можно с именем или инициалами в любом порядке: <code>Иванова</code>, <code>Дарья Иванова</code>, <code>Иванова Д.А.</code> Отмена: /cancel${limited}`, { parse_mode: "HTML" });
    return;
  }
  if (scope === "student") {
    const dir = deps.students;
    if (!studentsEnabled(deps) || !dir?.ready()) return void (await ctx.reply("Поиск людей пока не работает: база студентов не загружена. Админ кладёт её файлом на сервер (POISK_DB)."));
    if (!studentSearchAllowed(deps, ctx.user.id, ctx.isAdmin)) return void (await ctx.reply(`На сегодня лимит поисков людей исчерпан (${deps.config.POISK_DAILY_LIMIT} в день). Завтра снова можно.`));
    setPending(deps, ctx.user.id, { kind: "poisk" }, 5 * 60_000);
    await ctx.reply(`${POISK_INTRO}\n\n<i>В базе ${dir.count()} чел. ${coverageNote(ctx)}</i>`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖️ Отмена", "poisk:cancel") });
    return;
  }
  setPending(deps, ctx.user.id, { kind: "people", target: SCOPE_CODE.all }, 3 * 60_000);
  const who = studentsEnabled(deps) ? "и преподавателя, и студента" : "преподавателя";
  await ctx.reply(`Напиши фамилию — найду ${who}: <code>Иванова</code>, <code>Иванов Иван</code>. Опечатки прощаю. Отмена: /cancel`, { parse_mode: "HTML" });
}

/** Ничего не нашлось: объясняем почему, а не просто «нет». */
async function replyNotFound(ctx: BotContext, query: string, scope: PeopleScope, students: string): Promise<void> {
  const deps = ctx.deps;
  if (scope === "student") {
    const note = coverageNote(ctx);
    await ctx.reply(`Никого похожего на «${esc(query)}» в базе нет. Проверь фамилию — можно одну, без имени.${note ? `\n\n${note}` : ""}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔎 Попробовать ещё раз", "ppf:s") });
    return;
  }
  const err = deps.teachers?.lastError();
  const hint = err && ctx.isAdmin ? `\n\n<i>Админу: последняя ошибка портала — ${esc(err.slice(0, 200))}</i>` : "";
  const noAccount = !deps.teachers ? "\n\nСейчас бот знает только преподавателей дистанционных пар: полный справочник портал отдаёт лишь авторизованным." : "";
  const limit = scope === "all" && students === "limit" ? "\n\nСтудентов сегодня больше не ищу: дневной лимит поисков людей исчерпан." : "";
  const where = scope === "all" && students === "ok" ? " ни среди преподавателей, ни среди студентов" : "";
  await ctx.reply(`Никого не нашёл по «${esc(query)}»${where} — даже с поправкой на опечатки. Попробуй одну фамилию без имени или первые буквы фамилии; имя и фамилию можно в любом порядке.${noAccount}${limit}${hint}`, { parse_mode: "HTML" });
}

/**
 * Поиск по фамилии в пределах scope: один точный ответ — сразу карточка, иначе
 * кандидаты кнопками. Возвращает найденных (для «🔍 Поиск» и тестов).
 */
export async function runPeopleSearch(ctx: BotContext, query: string, scope: PeopleScope): Promise<PersonHit[]> {
  const deps = ctx.deps;
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  const res = await searchPeople(deps, query, { scope, viewerId: ctx.user.id, isAdmin: ctx.isAdmin, source: "поиск" });
  if (scope === "student" && res.students === "limit") {
    await ctx.reply(`На сегодня лимит поисков людей исчерпан (${deps.config.POISK_DAILY_LIMIT} в день).`);
    return [];
  }
  if (scope === "student" && res.students === "off") {
    await ctx.reply("Поиск людей выключен.");
    return [];
  }
  if (!res.hits.length) {
    await replyNotFound(ctx, query, scope, res.students);
    return [];
  }
  const clear = clearHit(res.hits);
  if (clear) {
    await showPerson(ctx, clear.ref, todayMsk());
    return res.hits;
  }
  const exact = res.hits.some((h) => !h.fuzzy);
  await ctx.reply(exact ? "Кого показать?" : `Точного совпадения с «${esc(query)}» нет. Может быть, кто-то из них?`, { parse_mode: "HTML", reply_markup: candidatesKeyboard(res.hits, scope) });
  return res.hits;
}

// ---- callbacks: единые ----

const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const KEY = "([tws][A-Za-z0-9_-]{1,16})";

peopleHandlers.callbackQuery(new RegExp(`^pp:${KEY}:${DATE}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const ref = parseRefKey(ctx.match[1]!);
  if (ref) await showPerson(ctx, ref, ctx.match[2]!, { edit: true });
});

peopleHandlers.callbackQuery(new RegExp(`^ppw:${KEY}:${DATE}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const ref = parseRefKey(ctx.match[1]!);
  if (ref) await showPerson(ctx, ref, ctx.match[2]!, { mode: "week", edit: true });
});

peopleHandlers.callbackQuery(new RegExp(`^ppo:${KEY}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const ref = parseRefKey(ctx.match[1]!);
  if (!ref) return;
  // В журнале должен стоять тот, кого реально открыли, а не первый из подсказок.
  if (ref.kind === "student" && studentsEnabled(ctx.deps)) ctx.deps.repo.markPoiskChoice(ctx.user.id, todayMsk(), ref.id);
  await showPerson(ctx, ref, todayMsk());
});

// Выбор конкретной группы, когда под одним номером их несколько.
peopleHandlers.callbackQuery(/^ppg:([A-Za-z0-9_-]{6,16}):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const group = ctx.deps.service.group(ctx.match[2]!);
  if (!group || !studentsEnabled(ctx.deps)) return void (await ctx.reply("Не нашёл — поищи заново."));
  chooseStudentGroup(ctx.user.id, ctx.match[1]!, group.key);
  await showPerson(ctx, { kind: "student", id: ctx.match[1]! }, todayMsk());
});

peopleHandlers.callbackQuery(/^ppf:([tsa])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptPeople(ctx, CODE_SCOPE[ctx.match[1]!] ?? "all");
});

peopleHandlers.callbackQuery("poisk:cancel", async (ctx) => {
  clearPending(ctx.deps, ctx.user.id);
  await ctx.answerCallbackQuery({ text: "Отменено" });
  try {
    await ctx.editMessageText("Поиск людей отменён.");
  } catch {
    /* ignore */
  }
});

peopleHandlers.callbackQuery(/^twf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  // Имя берём из своей базы: поход в справочник портала может занять минуту,
  // а Telegram ждёт ответа на нажатие несколько секунд и иначе «морозит» кнопку.
  const known = ctx.deps.repo.teacherMapById(id)?.name ?? ctx.deps.repo.watchedTeachers(ctx.user.id).find((w) => w.teacherId === id)?.name;
  const following = ctx.deps.repo.toggleWatchTeacher(ctx.user.id, id, known ?? `#${id}`);
  await ctx.answerCallbackQuery({
    text: following ? "Слежу: пришлю его расписание вечером и за 2 часа до первой пары" : "Больше не слежу за этим преподавателем",
    show_alert: following,
  });
  try {
    const msg = ctx.callbackQuery.message;
    const data = msg && "reply_markup" in msg ? msg.reply_markup : undefined;
    // Перерисовываем ту же клавиатуру, только с новой надписью на кнопке.
    if (data?.inline_keyboard) {
      const rows = data.inline_keyboard.map((row) => row.map((b) => ("callback_data" in b && b.callback_data === `twf:${id}` ? { ...b, text: following ? "🔕 Не следить за преподом" : "👁 Следить за преподом" } : b)));
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows } });
    }
  } catch {
    /* сообщение могло устареть */
  }
});

// ---- старые кнопки из уже отправленных сообщений: ведут в ту же карточку ----

peopleHandlers.callbackQuery(/^t:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPerson(ctx, { kind: "teacher", id: Number(ctx.match[1]) }, todayMsk());
});
peopleHandlers.callbackQuery(new RegExp(`^td:(\\d+):${DATE}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPerson(ctx, { kind: "teacher", id: Number(ctx.match[1]) }, ctx.match[2]!, { edit: true });
});
peopleHandlers.callbackQuery(new RegExp(`^tw:(\\d+):${DATE}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPerson(ctx, { kind: "teacher", id: Number(ctx.match[1]) }, ctx.match[2]!, { mode: "week", edit: true });
});
peopleHandlers.callbackQuery(/^wtc:([A-Za-z0-9_-]{16})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPerson(ctx, { kind: "webinar", key: ctx.match[1]! }, todayMsk());
});
peopleHandlers.callbackQuery(/^t:search$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptPeople(ctx, "teacher");
});

// Студенческие — только при включённом «сыске»; иначе нажатие ничего не делает.
peopleHandlers.callbackQuery(new RegExp(`^pos:([A-Za-z0-9_-]+):${DATE}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  if (studentsEnabled(ctx.deps)) await showPerson(ctx, { kind: "student", id: ctx.match[1]! }, ctx.match[2]!, { edit: true });
});
peopleHandlers.callbackQuery(new RegExp(`^posw:([A-Za-z0-9_-]+):${DATE}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  if (studentsEnabled(ctx.deps)) await showPerson(ctx, { kind: "student", id: ctx.match[1]! }, ctx.match[2]!, { mode: "week", edit: true });
});
peopleHandlers.callbackQuery(/^pop:([A-Za-z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!studentsEnabled(ctx.deps)) return;
  ctx.deps.repo.markPoiskChoice(ctx.user.id, todayMsk(), ctx.match[1]!);
  await showPerson(ctx, { kind: "student", id: ctx.match[1]! }, todayMsk());
});
peopleHandlers.callbackQuery(/^posg:([A-Za-z0-9_-]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const group = ctx.deps.service.group(ctx.match[2]!);
  if (!group || !studentsEnabled(ctx.deps)) return;
  chooseStudentGroup(ctx.user.id, ctx.match[1]!, group.key);
  await showPerson(ctx, { kind: "student", id: ctx.match[1]! }, todayMsk());
});

// ---- ввод фамилии после приглашения ----

peopleHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || (pending.kind !== "teacher" && pending.kind !== "poisk" && pending.kind !== "people")) return next();
  if (ctx.msg.text.startsWith("/")) return next();
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  clearPending(ctx.deps, ctx.user.id);
  const scope: PeopleScope = pending.kind === "teacher" ? "teacher" : pending.kind === "poisk" ? "student" : (CODE_SCOPE[pending.target ?? "a"] ?? "all");
  const query = ctx.msg.text.trim().slice(0, 100);
  await runPeopleSearch(ctx, query, scope);
});

/** Ключ для старых мест, где вебинарного преподавателя открывали по имени. */
export function webinarRef(name: string): PersonRef {
  return { kind: "webinar", key: webinarNameKey(name) };
}
