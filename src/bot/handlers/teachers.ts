/**
 * Кнопка «👨‍🏫 Преподаватели». Сам поиск, карточка и кнопки у преподавателя
 * и студента общие — они живут в src/bot/people.ts; здесь только вход.
 */
import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { BTN } from "../keyboards.js";
import { teacherMapByName } from "../../portal/teachers.js";
import { promptPeople } from "../people.js";
import { webinarNameKey } from "../../people/ref.js";

export const teacherHandlers = new Composer<BotContext>();

teacherHandlers.command("teachers", (ctx) => promptPeople(ctx, "teacher"));
teacherHandlers.hears(BTN.teachers, (ctx) => promptPeople(ctx, "teacher"));

/**
 * Callback key for a teacher known only from the webinar page (no portal id).
 * A digest, not the name: callback_data is limited to 64 bytes and two long
 * Cyrillic surnames would otherwise share a truncated prefix.
 */
export function webinarKey(name: string): string {
  return `wtc:${webinarNameKey(name)}`;
}

/**
 * «(ВИШ)» рядом с фамилией. В университете есть полные тёзки, и без пометки
 * невозможно понять, кто из них ведёт у нашей школы.
 */
export function teacherVishTag(repo: BotContext["deps"]["repo"], teacherId: number | null, name: string): string {
  const row = (teacherId != null ? repo.teacherMapById(teacherId) : null) ?? teacherMapByName(repo, name);
  return row?.vish ? " (ВИШ)" : "";
}
