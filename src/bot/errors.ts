import { GrammyError } from "grammy";

/**
 * Человеку больше нельзя писать: он заблокировал бота, удалил аккаунт или ни
 * разу не открывал с ботом личку (Telegram отвечает 403 «bot can't initiate
 * conversation» — так бывает с теми, кто пользовался только inline). Такие
 * отправки не надо повторять на каждой рассылке: человек помечается blocked,
 * а /start снимает пометку сам.
 *
 * «Чат не найден» и «аккаунт удалён» Telegram отдаёт кодом 400, поэтому текст
 * тоже проверяется.
 */
export function isUnreachable(err: unknown): boolean {
  if (err instanceof GrammyError && err.error_code === 403) return true;
  const text = err instanceof GrammyError ? err.description : String(err);
  return /blocked|deactivated|chat not found|can't initiate|bot was kicked|user not found/i.test(text);
}
