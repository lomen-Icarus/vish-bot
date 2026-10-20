/**
 * «Кворум» — открытая страница parlament.secretvish.ru/quorum: сколько
 * студентов каждой дневной группы ВИШ уже в боте. Наружу уходят только
 * названия групп и числа — ни имён, ни id. Сколько всего человек в группе,
 * страница берёт из своего файла totals.json (recorder/deploy/quorum/).
 */
import type { LogicalGroup } from "../schedule/groups.js";

export interface QuorumGroup {
  /** «ВИШ-11-23 (РЗиАЭС)». */
  title: string;
  course: number;
  /** Сколько студентов группы в боте. */
  users: number;
}

export interface QuorumSnapshot {
  updatedAt: string;
  groups: QuorumGroup[];
}

/** Дневные группы ВИШ в порядке списка групп бота; группа без людей — с нулём. */
export function quorumSnapshot(groups: readonly LogicalGroup[], students: ReadonlyMap<string, number>, now = new Date()): QuorumSnapshot {
  return {
    updatedAt: now.toISOString(),
    groups: groups.filter((g) => g.prefix === "ВИШ").map((g) => ({ title: g.title, course: g.course, users: students.get(g.key) ?? 0 })),
  };
}
