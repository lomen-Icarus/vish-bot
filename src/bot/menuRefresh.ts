/**
 * Меню в чате живёт, пока бот не пришлёт другое. Поменялось меню человека
 * (новые кнопки, режим преподавателя, «нижнее меню» в настройках) — новое
 * уходит с первым же его сообщением без своих кнопок. Что сейчас стоит у
 * человека, бот помнит в базе (отпечаток menu_sent), поэтому после
 * перезапуска меню заново не присылает: свёрнутое не раскрывается само.
 */
import type { Transformer } from "grammy";
import type { Repo } from "../db/repo.js";
import { menuFor, menuStamp } from "./keyboards.js";

export function menuRefresher(repo: Pick<Repo, "getUser" | "updateUser">): Transformer {
  return async (prev, method, payload, signal) => {
    const p = payload as { chat_id?: number | string; reply_markup?: unknown };
    const send = method === "sendMessage" || method === "sendPhoto" || method === "sendDocument";
    const user = send && typeof p.chat_id === "number" && p.chat_id > 0 ? repo.getUser(p.chat_id) : null;
    if (!user) return prev(method, payload, signal);
    const menu = menuFor(user);
    const stamp = menuStamp(menu);
    if (user.menuSent === stamp) return prev(method, payload, signal);
    // Свои кнопки у сообщения уже есть: запоминаем, только если это и есть меню
    // человека — меню потока основное не заменяет.
    if (p.reply_markup && menuStamp(p.reply_markup) !== stamp) return prev(method, payload, signal);
    const res = await prev(method, (p.reply_markup ? payload : { ...payload, reply_markup: menu }) as typeof payload, signal);
    repo.updateUser(user.id, { menuSent: stamp });
    return res;
  };
}
