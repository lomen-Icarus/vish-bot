/**
 * «Один экран» в МАКС. Нижнего меню у МАКС нет, а меню под каждым сообщением
 * засоряет чат, поэтому бот в МАКС ведёт себя как приложение: под каждым
 * экраном — одна кнопка «◀️ Меню», и нажатие кнопки меняет тот же экран, а не
 * присылает новое сообщение. Набранный текст — новый экран внизу (иначе ответ
 * оказался бы выше сообщения человека). Уведомления (изменения, напоминания)
 * — отдельные сообщения: их бот не перезаписывает.
 *
 * Ход — обработка одного события человека. В нём мост помнит, под каким
 * сообщением нажали кнопку: первый ответ бота встаёт на его место.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MaxButton } from "./api.js";

export interface ScreenTurn {
  uid: number;
  /** Номер сообщения, под которым нажали кнопку; null — человек написал сам. */
  replaceId: number | null;
  /** Экран уже заменён (или бот сам его поправил): дальше — новые сообщения. */
  replaced: boolean;
}

export const screenTurn = new AsyncLocalStorage<ScreenTurn>();

/** Кнопка «◀️ Меню» и кнопки самого меню (подпись — как у кнопки нижнего меню в Telegram). */
export const MENU_PAYLOAD = "mx:menu";
export const MENU_TEXT_PREFIX = "mx:t:";
export const MENU_BACK: MaxButton = { type: "callback", text: "◀️ Меню", payload: MENU_PAYLOAD };

/** Подпись кнопки нижнего меню → кнопка МАКС: нажатие придёт боту этой подписью, как в Telegram. */
export function menuItem(text: string): MaxButton {
  return { type: "callback", text, payload: `${MENU_TEXT_PREFIX}${text}` };
}
