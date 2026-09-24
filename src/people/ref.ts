/**
 * Кто такой «человек» в боте. Преподаватель и студент — одна сущность с
 * одной карточкой и одними кнопками, различается только источник данных:
 *
 *   t<id>   — преподаватель из справочника портала (нужна учётка);
 *   w<hash> — преподаватель, известный только по странице вебинаров;
 *   s<id>   — студент из реестра «сыска» (POISK=TRUE).
 *
 * Ключ короткий: он едет в callback_data, где у Telegram всего 64 байта.
 */
import { createHash } from "node:crypto";

export type PersonRef = { kind: "teacher"; id: number } | { kind: "webinar"; key: string } | { kind: "student"; id: string };

export type PersonRole = "teacher" | "student";

export function refKey(ref: PersonRef): string {
  if (ref.kind === "teacher") return `t${ref.id}`;
  if (ref.kind === "webinar") return `w${ref.key}`;
  return `s${ref.id}`;
}

/** Обратное к refKey; мусор — null. */
export function parseRefKey(raw: string): PersonRef | null {
  let m = /^t(\d{1,9})$/.exec(raw);
  if (m) return { kind: "teacher", id: Number(m[1]) };
  m = /^w([A-Za-z0-9_-]{16})$/.exec(raw);
  if (m) return { kind: "webinar", key: m[1]! };
  m = /^s([A-Za-z0-9_-]{6,16})$/.exec(raw);
  if (m) return { kind: "student", id: m[1]! };
  return null;
}

export function roleOf(ref: PersonRef): PersonRole {
  return ref.kind === "student" ? "student" : "teacher";
}

/**
 * Ключ преподавателя со страницы вебинаров: хэш имени, а не само имя — две
 * длинные фамилии не влезли бы в callback_data и совпали бы обрезками.
 * Тот же хэш, что и у старых кнопок «wtc:…», поэтому они продолжают работать.
 */
export function webinarNameKey(name: string): string {
  return createHash("sha1").update(name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()).digest("base64url").slice(0, 16);
}
