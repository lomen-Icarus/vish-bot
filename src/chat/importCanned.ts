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
