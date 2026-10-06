/**
 * Ссылки «t.me/бот?start=…» вместо кнопок. У альбома картинок в Telegram
 * кнопок не бывает, а уведомление об изменениях должно быть одним сообщением —
 * поэтому «📆 Файл изменений в календарь» и «👁 Не следить» в подписи к
 * альбому — ссылки. Telegram по ссылке показывает кнопку «Start», она
 * присылает боту «/start ics_…», и бот отвечает тем же, что и кнопка.
 *
 * В параметре start Telegram пускает только латиницу, цифры, «_» и «-» и не
 * больше 64 символов, а ключ группы — кириллица любой длины. Поэтому в ссылке
 * не сам ключ, а короткая метка: 12 символов от sha256 ключа (72 бита —
 * совпадений между десятками групп не будет); бот узнаёт группу, сверяя метку
 * с ключами, которые знает.
 */
import { createHash } from "node:crypto";

export type StartAction = "ics" | "unwatch";

/** Короткая постоянная метка группы для ссылки. */
export function groupRef(groupKey: string): string {
  return createHash("sha256").update(groupKey, "utf8").digest("base64url").slice(0, 12);
}

export function startPayload(action: StartAction, groupKey: string): string {
  return `${action}_${groupRef(groupKey)}`;
}

export function parseStartPayload(payload: string): { action: StartAction; ref: string } | null {
  const m = /^(ics|unwatch)_([A-Za-z0-9_-]{12})$/.exec(payload.trim());
  return m ? { action: m[1] as StartAction, ref: m[2]! } : null;
}

/** Какая из известных групп скрыта за меткой. */
export function resolveGroupRef(ref: string, keys: Iterable<string>): string | null {
  for (const key of keys) if (groupRef(key) === ref) return key;
  return null;
}

/** Ссылка на личку с ботом с параметром start; без имени бота — null. */
export function startLink(botUsername: string | null, action: StartAction, groupKey: string): string | null {
  return botUsername ? `https://t.me/${botUsername}?start=${startPayload(action, groupKey)}` : null;
}
