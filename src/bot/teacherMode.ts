/**
 * Режим преподавателя.
 *
 * Преподаватель из реестра (TEACHERS_DB, «ФИО;телеграм-ник») пишет боту со
 * своего аккаунта — и на /start режим включается сам: приветствие по
 * имени-отчеству, его расписание вместо выбора группы, предложение напоминаний.
 * Командой /prepod режим выключают (и включают обратно). Дальше бот ведёт себя как
 * для студента, только «своя группа» — это он сам: «Сегодня», «Завтра»,
 * «Неделя», «Следующая» показывают его пары, напоминания и календарь — тоже по
 * ним, а третья кнопка меню называется «👥 Студенты» и открывает расписание
 * любой группы. Кнопок, ведущих в режим, нет: пока только команда.
 *
 * Админ может проверить режим на любом преподавателе: /prepod Фамилия Имя.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext, Deps } from "./context.js";
import type { User } from "../db/repo.js";
import { dayNav, onboardingKeyboard, teacherKeyboard, mainKeyboard, weekNav } from "./keyboards.js";
import { esc } from "../schedule/format.js";
import { samePerson } from "../text/match.js";
import { mondayOf, todayMsk, type LocalDate } from "../time.js";
import { logger } from "../logger.js";
import { loadProfile, personDayView, personWeekView, type PersonProfile } from "../people/profile.js";
import { parseRefKey, refKey, type PersonRef } from "../people/ref.js";
import { searchPeople, type PersonHit } from "../people/search.js";
import { deliverPersonPoster } from "./people.js";

export const teacherModeHandlers = new Composer<BotContext>();

/** Ключ преподавателя этого пользователя в режиме преподавателя. */
export function ownTeacherRef(user: Pick<User, "teacherMode" | "teacherRef">): PersonRef | null {
  if (!user.teacherMode || !user.teacherRef) return null;
  const ref = parseRefKey(user.teacherRef);
  return ref && ref.kind !== "student" ? ref : null;
}

/** «Иванова Ирина Ивановна» → «Ирина Ивановна»: к преподавателю — по имени-отчеству. */
export function nameAndPatronymic(fio: string): string {
  const parts = fio.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 3 ? `${parts[1]} ${parts[2]}` : (parts[1] ?? parts[0] ?? fio);
}

/** ФИО этого человека по реестру преподавателей (по телеграм-нику). */
function registryName(ctx: BotContext): string | null {
  return ctx.deps.teacherRegistry?.byUsername(ctx.from?.username ?? ctx.user.username)?.name ?? null;
}

/** Кто из справочника (или со страницы вебинаров) — этот человек. */
async function resolveTeacher(ctx: BotContext, fio: string): Promise<PersonHit[]> {
  const res = await searchPeople(ctx.deps, fio, { scope: "teacher", viewerId: ctx.user.id, isAdmin: ctx.isAdmin, source: "поиск", limit: 8 });
  const exact = res.hits.filter((h) => !h.fuzzy && samePerson(h.name, fio));
  // Полные тёзки из других институтов: «наш» (ВИШ) — тот, кто нужен.
  const vish = exact.filter((h) => h.vish);
  return vish.length ? vish : exact;
}

/**
 * Преподаватель сам выключил режим (/prepod): тогда /start больше не включает
 * его обратно. Метка — в meta, чтобы не заводить ради неё столбец.
 */
const optOutKey = (userId: number): string => `tmode:off:${userId}`;

function switchOn(ctx: BotContext, fio: string, ref: PersonRef | null): void {
  ctx.deps.repo.updateUser(ctx.user.id, { teacherMode: true, teacherName: fio, teacherRef: ref ? refKey(ref) : null });
  ctx.deps.repo.setMeta(optOutKey(ctx.user.id), "");
  Object.assign(ctx.user, { teacherMode: true, teacherName: fio, teacherRef: ref ? refKey(ref) : null });
}

async function enable(ctx: BotContext, fio: string, ref: PersonRef | null): Promise<void> {
  switchOn(ctx, fio, ref);
  const found = ref ? "" : "\n\n<i>В справочнике портала тебя найти не получилось, поэтому расписание пока пустое. Напиши админу — он проверит, как ты записан на портале.</i>";
  await ctx.reply(
    `👨‍🏫 <b>Режим преподавателя</b> — ${esc(fio)}\n\n«📅 Сегодня», «📅 Завтра», «🗓 Неделя» — твои пары. «👥 Студенты» — расписание любой группы. Напоминания и календарь теперь тоже по твоему расписанию.\n\nВыключить: /prepod${found}`,
    { parse_mode: "HTML", reply_markup: teacherKeyboard() },
  );
  if (ref) await showOwnTeacher(ctx, todayMsk());
}

teacherModeHandlers.command("prepod", async (ctx) => {
  const deps = ctx.deps;
  if (ctx.user.teacherMode) {
    deps.repo.updateUser(ctx.user.id, { teacherMode: false });
    deps.repo.setMeta(optOutKey(ctx.user.id), "1");
    ctx.user.teacherMode = false;
    await ctx.reply("Режим преподавателя выключен: бот снова показывает расписание твоей группы.", { reply_markup: mainKeyboard() });
    return;
  }
  const arg = (ctx.match ?? "").trim();
  // Проверить режим на ком угодно может только админ; остальным — только себя по реестру.
  const fio = arg && ctx.isAdmin ? arg : registryName(ctx);
  if (!fio) {
    await ctx.reply(
      ctx.isAdmin
        ? "Тебя нет в реестре преподавателей (TEACHERS_DB). Для проверки режима: <code>/prepod Фамилия Имя Отчество</code>."
        : "Режим преподавателя пока только для преподавателей из реестра. Если ты преподаватель — напиши админу бота, он добавит тебя.",
      { parse_mode: "HTML" },
    );
    return;
  }
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  let hits: PersonHit[] = [];
  try {
    hits = await resolveTeacher(ctx, fio);
  } catch (err) {
    logger.warn({ err: String(err) }, "teacher mode: lookup failed");
  }
  if (hits.length > 1) {
    // Несколько полных тёзок — пусть человек сам скажет, кто он.
    const kb = new InlineKeyboard();
    for (const h of hits.slice(0, 6)) kb.text(`👨‍🏫 ${h.name}${h.vish ? " (ВИШ)" : ""}`.slice(0, 60), `tmode:${refKey(h.ref)}`).row();
    deps.repo.updateUser(ctx.user.id, { teacherName: fio });
    await ctx.reply(`В справочнике несколько «${esc(fio)}». Кто из них ты?`, { parse_mode: "HTML", reply_markup: kb });
    return;
  }
  await enable(ctx, fio, hits[0]?.ref ?? null);
});

teacherModeHandlers.callbackQuery(/^tmode:([tw][A-Za-z0-9_-]{1,16})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ref = parseRefKey(ctx.match[1]!);
  const fio = ctx.deps.repo.getUser(ctx.user.id)?.teacherName ?? registryName(ctx);
  if (!ref || !fio) return;
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  if (ctx.deps.repo.getMeta(pendingWelcomeKey(ctx.user.id))) {
    // Выбор из приветствия /start: встречаем так же, как того, кого узнали сразу.
    ctx.deps.repo.setMeta(pendingWelcomeKey(ctx.user.id), "");
    switchOn(ctx, fio, ref);
    await welcome(ctx, fio, ref);
    return;
  }
  await enable(ctx, fio, ref);
});

/** Полные тёзки в справочнике: приветствие ждёт, пока преподаватель выберет себя. */
const pendingWelcomeKey = (userId: number): string => `tmode:welcome:${userId}`;

/**
 * Первая встреча с преподавателем из реестра: по имени-отчеству, сразу его
 * расписание вместо выбора группы и предложение включить напоминания.
 */
async function welcome(ctx: BotContext, fio: string, ref: PersonRef | null): Promise<void> {
  const name = nameAndPatronymic(fio);
  const missing = ref ? "" : "\n\n<i>В справочнике портала вас найти не получилось, поэтому расписание пока пустое. Мы проверим, как вы записаны на портале.</i>";
  await ctx.reply(
    `Здравствуйте, ${esc(name)}! Рад вас видеть 👋\n\nЯ вас узнал, поэтому вместо группы здесь ваше собственное расписание: «📅 Сегодня», «📅 Завтра», «🗓 Неделя» — ваши пары, «👥 Студенты» — расписание любой группы. Спросить что угодно — «🔍 ИИ поисковик».\n\nВыключить этот режим: /prepod${missing}`,
    { parse_mode: "HTML", reply_markup: teacherKeyboard() },
  );
  if (ref) await showOwnTeacher(ctx, todayMsk());
  await ctx.reply(
    "Включить напоминания с рекомендуемыми настройками?\n\n• за 2 часа до первой пары\n• за 5 минут до дистанционной пары — ссылка на вебинар\n\nВсё это потом можно поменять в ⚙️ Настройках.",
    { reply_markup: onboardingKeyboard() },
  );
}

/**
 * /start от преподавателя из реестра: режим включается сам, без выбора группы.
 * Возвращает true, если /start обработан здесь. Не трогает того, кто уже в
 * режиме (его встречает обычный /start), и того, кто сам его выключил.
 */
export async function autoTeacherStart(ctx: BotContext): Promise<boolean> {
  if (ctx.user.teacherMode) return false;
  const fio = registryName(ctx);
  if (!fio || ctx.deps.repo.getMeta(optOutKey(ctx.user.id))) return false;
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  let hits: PersonHit[] = [];
  try {
    hits = await resolveTeacher(ctx, fio);
  } catch (err) {
    logger.warn({ err: String(err) }, "teacher mode: lookup on /start failed");
  }
  if (hits.length > 1) {
    const kb = new InlineKeyboard();
    for (const h of hits.slice(0, 6)) kb.text(`👨‍🏫 ${h.name}${h.vish ? " (ВИШ)" : ""}`.slice(0, 60), `tmode:${refKey(h.ref)}`).row();
    ctx.deps.repo.updateUser(ctx.user.id, { teacherName: fio });
    ctx.deps.repo.setMeta(pendingWelcomeKey(ctx.user.id), "1");
    await ctx.reply(`Здравствуйте, ${esc(nameAndPatronymic(fio))}! Рад вас видеть 👋\n\nВ справочнике портала несколько «${esc(fio)}». Кто из них вы?`, { parse_mode: "HTML", reply_markup: kb });
    return true;
  }
  const ref = hits[0]?.ref ?? null;
  switchOn(ctx, fio, ref);
  logger.info({ userId: ctx.user.id, found: !!ref }, "teacher mode switched on by the registry");
  await welcome(ctx, fio, ref);
  return true;
}

/**
 * Своё расписание преподавателя — та же карточка, что у любого человека, но с
 * кнопками «своей группы»: стрелки и «Неделя» (d:/w:), календарь под неделей.
 */
export async function showOwnTeacher(ctx: BotContext, date: LocalDate, opts: { mode?: "day" | "week"; edit?: boolean } = {}): Promise<void> {
  const ref = ownTeacherRef(ctx.user);
  if (!ref) {
    await ctx.reply("В режиме преподавателя, но в справочнике портала тебя не нашлось — расписание показать не могу. Напиши админу, он проверит, как ты записан на портале. Выключить режим: /prepod");
    return;
  }
  const profile = await loadOwnProfile(ctx.deps, ref);
  if (!profile) {
    await ctx.reply("Не получилось загрузить твоё расписание: справочник преподавателей сейчас недоступен. Попробуй позже.");
    return;
  }
  const mode = opts.mode ?? "day";
  const view = mode === "day" ? await personDayView(ctx.deps, profile, date, ctx.user) : await personWeekView(ctx.deps, profile, date, ctx.user);
  const kb = mode === "day" ? dayNav(date, todayMsk(), { image: false }) : weekNav(mondayOf(date), { image: false });
  // Формат «картинка» — постером, как у студента своя группа.
  if (await deliverPersonPoster(ctx, profile, view, { mode, date, kb, edit: !!opts.edit })) return;
  const m = ctx.callbackQuery?.message;
  if (opts.edit && m && !("photo" in m && m.photo)) {
    try {
      await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: kb });
}

async function loadOwnProfile(deps: Deps, ref: PersonRef): Promise<PersonProfile | null> {
  try {
    return await loadProfile(deps, ref);
  } catch (err) {
    logger.warn({ err: String(err) }, "teacher mode: profile failed");
    return null;
  }
}
