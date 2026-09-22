/**
 * Разовые уборки в базе: то, что нельзя починить правкой кода, потому что
 * плохие строки уже записаны.
 */
import type { Repo } from "./repo.js";
import { changedFields } from "../schedule/diff.js";
import type { Occurrence } from "../schedule/model.js";
import { logger } from "../logger.js";

const DONE_KEY = "cleanup:falseChanges";

/**
 * Вычищает «изменения», которых по нынешним правилам не было бы вовсе.
 *
 * Когда бот впервые вошёл на портал под учёткой, у каждой пары разом появился
 * преподаватель, и сравнение записало это как изменение расписания — сотни
 * строк в разделе «Изменения» на недели вперёд, хотя расписание не менялось.
 * Правило уже исправлено, но записи остались: пересчитываем каждую правку
 * теми же правилами, что работают сейчас, и удаляем те, что не набрали ни
 * одного настоящего отличия.
 */
export function pruneFalseChangeEvents(repo: Repo, opts: { force?: boolean } = {}): number {
  if (!opts.force && repo.getMeta(DONE_KEY) === "1") return 0;
  const doomed: number[] = [];
  for (const row of repo.changedEventPayloads()) {
    try {
      const payload = JSON.parse(row.payload) as { before?: Occurrence; after?: Occurrence };
      if (!payload.before || !payload.after) continue;
      if (!changedFields(payload.before, payload.after).length) doomed.push(row.id);
    } catch {
      // Нечитаемую запись не трогаем: пусть лучше останется лишняя строка.
    }
  }
  const removed = repo.deleteChangeEvents(doomed);
  repo.setMeta(DONE_KEY, "1");
  if (removed) logger.info({ removed }, "убраны ложные изменения расписания");
  return removed;
}
