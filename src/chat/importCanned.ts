/**
 * Перенос базы ответов первой версии бота в группах (таблица canned_replies,
 * команда /reply_add) в файл сценария. Делается один раз: после переноса в
 * meta ставится отметка, и дальше сценарий правится только через файл и /qa_*.
 * Там ответ требовался дословно — так и помечаем подсказкой.
 */
import type { Repo } from "../db/repo.js";
import type { QaBase } from "./qa.js";
import { logger } from "../logger.js";

const DONE_KEY = "chat:canned-imported";

export function importLegacyCanned(repo: Repo, qa: QaBase): number {
  if (repo.getMeta(DONE_KEY)) return 0;
  let rows: Array<{ trigger: string; answer: string }> = [];
  try {
    rows = repo.legacyCannedReplies();
  } catch (err) {
    logger.warn({ err: String(err) }, "legacy canned replies unreadable");
  }
  let added = 0;
  for (const r of rows) {
    if (!r.trigger.trim() || !r.answer.trim()) continue;
    // Уже есть в сценарии (например, файл положили руками) — второй раз не пишем.
    if (qa.match(r.trigger, 1)[0]?.how === "exact") continue;
    qa.append([r.trigger.trim()], r.answer.trim(), "дословно");
    added++;
  }
  repo.setMeta(DONE_KEY, new Date().toISOString());
  if (rows.length) logger.info({ total: rows.length, added }, "legacy canned replies moved to the chat scenario");
  return added;
}

const SEED_KEY = "chat:qa-seed:v1";

/**
 * Заготовки, которые владелец бота попросил положить в сценарий. Кладутся в
 * файл один раз (отметка в meta): удалишь через /qa_del — не вернутся.
 */
export const DEFAULT_QA: Array<{ questions: string[]; answer: string; hint: string | null }> = [
  { questions: ["иди нахуй", "иди на хуй", "пошёл нахуй", "пошел нахуй", "пошла нахуй", "нахуй иди"], answer: "Сам иди злюка :(", hint: "дословно" },
];

export function seedDefaultQa(repo: Repo, qa: QaBase): number {
  if (repo.getMeta(SEED_KEY)) return 0;
  let added = 0;
  try {
    for (const e of DEFAULT_QA) {
      // Уже есть в сценарии (положили руками) — второй раз не пишем.
      if (e.questions.some((q) => qa.match(q, 1)[0]?.how === "exact")) continue;
      qa.append(e.questions, e.answer, e.hint);
      added++;
    }
  } catch (err) {
    // Файл не записался (нет прав, диск) — попробуем при следующем запуске.
    logger.warn({ err: String(err) }, "default chat Q&A not written");
    return added;
  }
  repo.setMeta(SEED_KEY, new Date().toISOString());
  if (added) logger.info({ added }, "default chat Q&A added to the scenario");
  return added;
}
