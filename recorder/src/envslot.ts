/**
 * Как профиль из .env становится слотом (deploy/env-to-slots.sh → import-env.ts).
 * Отдельно от import-env.ts: тот при импорте сразу запускает перенос.
 */
import type { WebinarProfile } from "./config.js";

/** Код группы для сверки со строками вебинаров: «14-25», «11-23(эиэа)» (как у бота). */
export function groupCode(title: string): string {
  const m = /(\d{1,2}-\d{2}(?:\s*\([^)]*\))?)/.exec(title);
  return (m ? m[1]! : title).toLowerCase().replace(/ё/g, "е").replace(/\s*\(/g, "(").trim();
}

/**
 * Слот из профиля .env: своя группа владельца + все группы, на которые профиль
 * был заведён (как есть — сверка с парами та же, что была у профиля).
 */
export function profileToSlot(profile: Pick<WebinarProfile, "groups">, ownGroup: string): { group: string; codes: string[] } {
  const own = groupCode(ownGroup);
  const rest = profile.groups.filter((g) => groupCode(g) !== own);
  return { group: ownGroup, codes: [own, ...rest] };
}
