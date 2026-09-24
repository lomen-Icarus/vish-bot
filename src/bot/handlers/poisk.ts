/**
 * «Сыск» — глобальный поиск студента.
 *
 * Включается переменной POISK=TRUE. При POISK=FALSE этот Composer вообще не
 * подключается к боту (см. src/bot/index.ts), поэтому раздела нет ни в
 * кнопках, ни в командах.
 *
 * Бот берёт ФИО из отдельного файла на хостинге (POISK_DB, в репозиторий он не
 * попадает), находит группу и подгруппу человека и показывает, где он должен
 * быть сейчас по расписанию, плюс расписание на день с обычными кнопками.
 * Это расписание группы, а не слежка: ходит ли человек на пары, бот не знает.
 *
 * Поиск, карточка и кнопки у студента и преподавателя общие — src/bot/people.ts.
 */
import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { BTN } from "../keyboards.js";
import { promptPeople } from "../people.js";

export { POISK_INTRO } from "../people.js";

export const poiskHandlers = new Composer<BotContext>();

poiskHandlers.command("poisk", (ctx) => promptPeople(ctx, "student"));
poiskHandlers.hears(BTN.whereStudent, (ctx) => promptPeople(ctx, "student"));
poiskHandlers.callbackQuery("poisk:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptPeople(ctx, "student");
});
