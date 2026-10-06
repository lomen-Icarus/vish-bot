/**
 * Ссылки «t.me/бот?start=…» вместо кнопок. У альбома картинок в Telegram
 * кнопок не бывает, а уведомление об изменениях должно быть одним сообщением —
 * поэтому «📆 Файл изменений в календарь» и «👁 Не следить» в подписи к
 * альбому — ссылки: нажатие присылает боту «/start ics_…», и он отвечает тем
 * же, что и кнопка.
 *
 * В параметре start Telegram пускает только латиницу, цифры, «_» и «-» и не
 * больше 64 символов, а ключ группы — кириллица («виш-12-23»), поэтому ключ
 * кодируем в base64url.
 */
const START_MAX = 64;

export type StartAction = "ics" | "unwatch";

export function startPayload(action: StartAction, groupKey: string): string | null {
  const payload = `${action}_${Buffer.from(groupKey, "utf8").toString("base64url")}`;
  return payload.length <= START_MAX ? payload : null;
}

export function parseStartPayload(payload: string): { action: StartAction; groupKey: string } | null {
  const m = /^(ics|unwatch)_([A-Za-z0-9_-]+)$/.exec(payload.trim());
  if (!m) return null;
  const groupKey = Buffer.from(m[2]!, "base64url").toString("utf8");
  return groupKey ? { action: m[1] as StartAction, groupKey } : null;
}

/** Ссылка на личку с ботом с параметром start; без имени бота или с длинным ключом — null. */
export function startLink(botUsername: string | null, action: StartAction, groupKey: string): string | null {
  const payload = startPayload(action, groupKey);
  return botUsername && payload ? `https://t.me/${botUsername}?start=${payload}` : null;
}
