/**
 * «Кворум» — открытая страница parlament.secretvish.ru/quorum: сколько
 * студентов каждой дневной группы ВИШ уже в боте — отдельно в Telegram и в
 * МАКС (человек в обоих — две записи, которые не связать). Наружу уходят только
 * названия групп и числа — ни имён, ни id. Сколько всего человек в группе,
 * страница берёт из своего файла totals.json (recorder/deploy/quorum/).
 */
import type { LogicalGroup } from "../schedule/groups.js";

export interface QuorumGroup {
  /** «ВИШ-11-23 (РЗиАЭС)». */
  title: string;
  course: number;
  /** Сколько студентов группы в боте в Telegram. */
  tg: number;
  /** Сколько студентов группы в боте в МАКС. */
  max: number;
}

export interface QuorumSnapshot {
  updatedAt: string;
  groups: QuorumGroup[];
}

/** Дневные группы ВИШ в порядке списка групп бота; группа без людей — с нулями. */
export function quorumSnapshot(groups: readonly LogicalGroup[], students: ReadonlyMap<string, { tg: number; max: number }>, now = new Date()): QuorumSnapshot {
  return {
    updatedAt: now.toISOString(),
    groups: groups
      .filter((g) => g.prefix === "ВИШ")
      .map((g) => ({ title: g.title, course: g.course, tg: students.get(g.key)?.tg ?? 0, max: students.get(g.key)?.max ?? 0 })),
  };
}
