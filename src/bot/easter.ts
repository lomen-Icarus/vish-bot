/**
 * Пасхалка про Кирилла Ершова, спорторга ВИШ: это он уговорил добавить в бот
 * преподавателей. Побочный эффект того дня все помнят: у каждой пары вдруг
 * появился преподаватель (было «никого» — стало ФИО), бот счёл это изменением
 * и разослал всем «изменения в расписании» по всем предметам сразу.
 *
 * Где живёт: карточка по запросу «Ершов» в «🔍 ИИ поисковик», /ask, поиске
 * преподавателей и inline, и секретная команда /ershov (ни в одном меню её нет).
 * Настоящего преподавателя-однофамильца пасхалка не прячет: поиск идёт дальше.
 */
import { Composer } from "grammy";
import type { BotContext, Deps } from "./context.js";
import { searchPeople, type PersonHit } from "../people/search.js";

export const easterHandlers = new Composer<BotContext>();

/** Цифры остаются словами: «Ершов 25.09» или «ершов 12-23» — это уже про расписание. */
function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** «Ершов», «Кирилл Ершов», «ершов кирилл спорторг», «кто такой Ершов?», «спорторг ВИШ». */
const FILLER = new Set(["кто", "такой", "это", "а", "где", "про", "виш"]);
const SURNAME = new Set(["ершов", "ершову", "ершовым"]);
const FIRST = new Set(["кирилл", "кирил", "кирилла"]);
const ALLOWED = new Set([...SURNAME, ...FIRST, "ершова", "спорторг"]);

export function isErshovQuery(query: string): boolean {
  const words = norm(query)
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
  if (words.length === 1 && words[0] === "спорторг") return true;
  if (!words.length || words.length > 3 || !words.every((w) => ALLOWED.has(w))) return false;
  // «Ершова» — это и «про Ершова», и женская фамилия: преподавателя Ершову
  // пасхалка перехватывать не должна, поэтому без имени Кирилла не считается.
  return words.some((w) => SURNAME.has(w)) || (words.includes("ершова") && words.some((w) => FIRST.has(w)));
}

/**
 * Настоящие однофамильцы — преподаватели Ершов/Ершова из расписания, которых
 * показывают после карточки. Одно правило на все места (поиск, ИИ-поисковик,
 * /ask, inline):
 *  • ищем по фамилии, а не по всему запросу — иначе «Кирилл Ершов» дал бы
 *    любого преподавателя Кирилла;
 *  • только точная фамилия: «Ежов» с поправкой на опечатку — не однофамилец;
 *  • только преподаватели и только своя база: студентов пасхалка не ищет и в
 *    журнал поиска людей не пишет, на портал за шуткой не ходит;
 *  • на «спорторг» — никого: фамилии в запросе нет;
 *  • сами не открываются: только кнопками, выбирает человек.
 */
export async function ershovNamesakes(deps: Deps, query: string, viewer: { id: number; isAdmin: boolean }): Promise<PersonHit[]> {
  if (!norm(query).split(" ").some((w) => SURNAME.has(w) || w === "ершова")) return [];
  const res = await searchPeople(deps, "Ершов", { scope: "teacher", viewerId: viewer.id, isAdmin: viewer.isAdmin, source: "поиск", localOnly: true }).catch(() => null);
  return (res?.hits ?? []).filter((h) => !h.fuzzy && ["ершов", "ершова"].includes(norm(h.name).split(" ")[0] ?? ""));
}

export const ERSHOV_CARD = [
  "🏅 <b>Кирилл Ершов</b> — спорторг ВИШ",
  "",
  "Это с его подачи в боте появились преподаватели: кто ведёт пару, расписание любого преподавателя, фото и «где он сейчас».",
  "",
  "<i>Побочный эффект запомнили все: в день, когда преподаватели впервые появились в расписании, бот решил, что изменилось вообще всё, и честно разослал «изменения в расписании» по всем предметам. Пары были ни при чём — просто у каждой вдруг появился преподаватель 😅</i>",
  "",
  "Спасибо, Кирилл! 💪",
].join("\n");

export const ERSHOV_ACHIEVEMENT = [
  "🏆 <b>Достижение открыто!</b>",
  "",
  "«<b>Уронил расписание всему ВИШу</b>»",
  "Получил: Кирилл Ершов, спорторг ВИШ",
  "Редкость: 1 из 1",
  "",
  "<i>Условие: уговорить добавить в бот преподавателей — так, чтобы на следующее утро каждый студент получил «изменения в расписании» по всем предметам сразу. Расписание при этом не изменилось ни на минуту.</i>",
  "",
  "Зато теперь в боте есть преподаватели. Оно того стоило 🫡",
].join("\n");

export async function sendErshovCard(ctx: BotContext): Promise<void> {
  await ctx.reply(ERSHOV_CARD, { parse_mode: "HTML" });
}

// Секретная команда: ни в /help, ни в меню команд её нет.
easterHandlers.command(["ershov", "ershow"], async (ctx) => {
  await ctx.reply(ERSHOV_ACHIEVEMENT, { parse_mode: "HTML" });
});
