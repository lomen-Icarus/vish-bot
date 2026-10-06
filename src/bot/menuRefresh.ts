/**
 * Меню в чате живёт, пока бот не пришлёт другое. Поменялось меню человека
 * (новые кнопки, режим преподавателя, «нижнее меню» в настройках) — новое
 * уходит с первым же его сообщением без своих кнопок. Что сейчас стоит у
 * человека, бот помнит в базе (отпечаток menu_sent), поэтому после
 * перезапуска меню заново не присылает: свёрнутое не раскрывается само.
 * Отпечаток забывается, когда меню у человека могло пропасть: /start (чат
 * могли очистить), блокировка бота (чат могли удалить).
 */
import type { Transformer } from "grammy";
import type { Repo } from "../db/repo.js";
import { logger } from "../logger.js";
import { menuFor, menuStamp, menuStampFor } from "./keyboards.js";

/** Кнопки под сообщением (inline) или «ответить» — к нижнему меню отношения не имеют. */
const notMenu = (markup: unknown): boolean => !!markup && typeof markup === "object" && !("keyboard" in markup) && !("remove_keyboard" in markup);

export function menuRefresher(repo: Pick<Repo, "getUser" | "updateUser">): Transformer {
  return async (prev, method, payload, signal) => {
    const p = payload as { chat_id?: number | string; reply_markup?: unknown };
    const send = method === "sendMessage" || method === "sendPhoto" || method === "sendDocument";
    // Дешёвые проверки — до базы: большинство уведомлений идёт с кнопками под сообщением.
    if (!send || typeof p.chat_id !== "number" || p.chat_id <= 0 || notMenu(p.reply_markup)) return prev(method, payload, signal);
    const user = repo.getUser(p.chat_id);
    if (!user) return prev(method, payload, signal);
    const stamp = menuStampFor(user);
    if (user.menuSent === stamp) return prev(method, payload, signal);
    // Меню у сообщения уже своё: запоминаем, только если это и есть меню
    // человека — меню потока основное не заменяет.
    if (p.reply_markup && menuStamp(p.reply_markup) !== stamp) return prev(method, payload, signal);
    const res = await prev(method, (p.reply_markup ? payload : { ...payload, reply_markup: menuFor(user) }) as typeof payload, signal);
    // Сообщение уже ушло: сбой записи не должен выглядеть как неудачная отправка.
    try {
      repo.updateUser(user.id, { menuSent: stamp });
    } catch (err) {
      logger.warn({ err: String(err) }, "menu stamp not saved");
    }
    return res;
  };
}
