/**
 * Текст и кнопки между Telegram и МАКС. HTML у них почти один: МАКС понимает
 * b, i, u, s, code, pre, a и blockquote — ровно то, чем пишет бот. Кнопки —
 * те же ряды, только у кнопки МАКС «payload», а не callback_data.
 */
import type { MessageEntity } from "grammy/types";
import { esc } from "../schedule/format.js";
import type { MaxButton } from "./api.js";

/** Лимит текста сообщения МАКС (у Telegram — 4096). */
export const MAX_TEXT_LIMIT = 4000;

const ENTITY_TAGS: Partial<Record<MessageEntity["type"], string>> = {
  bold: "b",
  italic: "i",
  underline: "u",
  strikethrough: "s",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
  expandable_blockquote: "blockquote",
};

/** Текст Telegram с разметкой (entities) → HTML для МАКС. Смещения — в UTF-16, как и у строк JS. */
export function entitiesToHtml(text: string, entities: readonly MessageEntity[] | undefined): string {
  if (!entities?.length) return esc(text);
  const opens = new Map<number, Array<{ end: number; tag: string }>>();
  const closes = new Map<number, Array<{ start: number; tag: string }>>();
  for (const e of entities) {
    const name = e.type === "text_link" ? "a" : ENTITY_TAGS[e.type];
    if (!name || e.length <= 0) continue;
    const open = e.type === "text_link" ? `<a href="${esc(e.url).replace(/"/g, "&quot;")}">` : `<${name}>`;
    const end = e.offset + e.length;
    (opens.get(e.offset) ?? opens.set(e.offset, []).get(e.offset)!).push({ end, tag: open });
    (closes.get(end) ?? closes.set(end, []).get(end)!).push({ start: e.offset, tag: `</${name}>` });
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    // Закрываем раньше открытые позже (вложенность), открываем длинные первыми.
    for (const c of (closes.get(i) ?? []).sort((a, b) => b.start - a.start)) out += c.tag;
    for (const o of (opens.get(i) ?? []).sort((a, b) => b.end - a.end)) out += o.tag;
    if (i < text.length) out += esc(text[i]!);
  }
  return out;
}

/**
 * Ссылки «t.me/бот?start=…» (в подписи к альбому изменений) ведут человека из
 * МАКС в Telegram — подменяем на того же бота в МАКС.
 */
export function rewriteBotLinks(html: string, tgUsername: string | null, maxUsername: string | null): string {
  if (!tgUsername || !maxUsername) return html;
  const re = new RegExp(`https?://t\\.me/${tgUsername.replace(/[^A-Za-z0-9_]/g, "")}(?=[?"'/\\s<]|$)`, "gi");
  return html.replace(re, `https://max.ru/${maxUsername}`);
}

/** Теги Telegram, которых у МАКС нет: спойлер становится обычным текстом. */
export function toMaxHtml(html: string): string {
  return html
    .replace(/<\/?tg-spoiler>/g, "")
    .replace(/<span class="tg-spoiler">([\s\S]*?)<\/span>/g, "$1")
    .replace(/<blockquote expandable>/g, "<blockquote>");
}

/** Кнопка Telegram под сообщением → кнопка МАКС; null — у МАКС такой нет (inline-режим, мини-приложение Telegram). */
function inlineButton(b: Record<string, unknown>): MaxButton | null {
  const text = String(b.text ?? "");
  if (typeof b.callback_data === "string") return { type: "callback", text, payload: b.callback_data };
  if (typeof b.url === "string") return { type: "link", text, url: b.url };
  const copy = b.copy_text as { text?: string } | undefined;
  if (copy?.text) return { type: "clipboard", text, payload: copy.text };
  return null;
}

/**
 * reply_markup Telegram → ряды кнопок МАКС. Нижнее меню (ReplyKeyboard) у МАКС
 * нет, но есть кнопка «message»: нажал — и её подпись приходит боту как
 * сообщение, как от кнопки нижнего меню в Telegram.
 */
export function markupToButtons(markup: unknown): MaxButton[][] | null {
  if (!markup || typeof markup !== "object") return null;
  const m = markup as { inline_keyboard?: unknown[][]; keyboard?: unknown[][] };
  if (Array.isArray(m.inline_keyboard)) {
    const rows = m.inline_keyboard.map((row) => row.map((b) => inlineButton(b as Record<string, unknown>)).filter((b): b is MaxButton => !!b)).filter((row) => row.length);
    return rows.length ? rows : null;
  }
  if (Array.isArray(m.keyboard)) {
    const rows = m.keyboard
      .map((row) => row.map((b): MaxButton => ({ type: "message", text: typeof b === "string" ? b : String((b as { text?: string }).text ?? "") })).filter((b) => b.text))
      .filter((row) => row.length);
    return rows.length ? rows : null;
  }
  return null;
}

/** Есть ли в разметке что-то, кроме «убрать меню» / «ответить». */
export function hasOwnMarkup(markup: unknown): boolean {
  return !!markup && typeof markup === "object" && ("inline_keyboard" in markup || "keyboard" in markup);
}
