/**
 * Вызовы Telegram Bot API → МАКС. Транспортный слой grammY (transformer):
 * каждый вызов бота проходит здесь, и если чат — человек из МАКС (uid моста),
 * вызов уходит в МАКС, а боту возвращается ответ «как от Telegram». Всё
 * остальное идёт в Telegram как раньше. Поэтому уведомления, напоминания,
 * рассылки и экраны работают в МАКС без отдельного кода.
 *
 * Чего у МАКС нет — inline-режима, групп Telegram, стикеров, анимаций — на то
 * мост отвечает ошибкой 400: обработчики бота такое уже переживают.
 */
import type { Transformer } from "grammy";
import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import { captionFits, clampHtml } from "../schedule/format.js";
import { logger } from "../logger.js";
import { MaxApiError, type MaxApi, type MaxAttachment, type MaxButton, type MaxNewMessage } from "./api.js";
import { entitiesToHtml, hasOwnMarkup, markupToButtons, MAX_TEXT_LIMIT, rewriteBotLinks, toMaxHtml } from "./format.js";
import { isMaxChat, type MaxMessageStore, type StoredMaxMessage, type TgSnapshotStore } from "./store.js";
import { MAX_CALLBACK_PREFIX } from "./updates.js";

type Payload = Record<string, unknown>;
type Prev = Parameters<Transformer>[0];
type Signal = Parameters<Prev>[2];

export interface OutgoingDeps {
  api: MaxApi;
  messages: MaxMessageStore;
  snapshots: TgSnapshotStore;
  /** id в МАКС по uid моста; null — человек неизвестен. */
  maxIdOf: (uid: number) => number | null;
  /** Нижнее меню человека (как в Telegram): у МАКС его нет, кнопки ставятся под сообщением. */
  menuFor: (uid: number) => unknown;
  /** Ник бота в Telegram и в МАКС — для подмены ссылок t.me/бот?start=…. */
  tgUsername: () => string | null;
  maxUsername: () => string | null;
  /** Токен Telegram: файл, известный только по file_id, приходится скачать у Telegram. */
  botToken: string;
}

/** Ошибка «как от Telegram»: её обработчики бота уже умеют разбирать (isUnreachable, autoRetry). */
class TgLikeError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

const unsupported = (method: string): TgLikeError => new TgLikeError(400, `Bad Request: ${method} is not available in MAX`);

function toTgError(err: unknown): TgLikeError {
  if (err instanceof TgLikeError) return err;
  if (err instanceof MaxApiError) {
    if (err.status === 429) return new TgLikeError(429, "Too Many Requests: MAX rate limit", 2);
    // Человек остановил бота или удалил диалог — для бота это «заблокировал».
    if (err.status === 403) return new TgLikeError(403, "Forbidden: bot was blocked by the user");
    if (err.status === 404 && /chat|user|dialog/i.test(err.code)) return new TgLikeError(400, "Bad Request: chat not found");
    if (err.status >= 500) return new TgLikeError(500, `Internal Server Error: MAX ${err.status}`);
    // Текст ошибки МАКС в описание не кладём: в нём могут оказаться слова,
    // по которым бот решил бы, что человек недоступен (isUnreachable).
    return new TgLikeError(400, `Bad Request: MAX ${err.status} ${err.code.replace(/[^\w.-]/g, "")}`);
  }
  // Сеть: пусть autoRetry попробует ещё раз, как при сбое Telegram.
  return new TgLikeError(500, "Internal Server Error: MAX network error");
}

/** Текст вызова Telegram → HTML для МАКС (с подменой ссылок на бота и лимитом длины). */
function htmlOf(d: OutgoingDeps, text: unknown, parseMode: unknown, entities: unknown): string | null {
  if (typeof text !== "string" || !text) return null;
  const html = parseMode === "HTML" ? text : entitiesToHtml(text, Array.isArray(entities) ? entities : undefined);
  return clampHtml(rewriteBotLinks(toMaxHtml(html), d.tgUsername(), d.maxUsername()), MAX_TEXT_LIMIT);
}

function keyboard(buttons: MaxButton[][] | null): MaxAttachment[] {
  return buttons ? [{ type: "inline_keyboard", payload: { buttons } }] : [];
}

/**
 * Кнопки сообщения. Свои — как есть. Своих нет — нижнее меню человека: в
 * Telegram оно всегда под полем ввода, а в МАКС его нет вовсе, и без кнопок
 * под ответом человеку некуда нажать. Тихие сообщения (первая половина
 * «текст + постер», ночные) — без меню: следом придёт сообщение со своими кнопками.
 */
function buttonsFor(d: OutgoingDeps, uid: number, p: Payload): MaxButton[][] | null {
  if (p.reply_markup !== undefined) return hasOwnMarkup(p.reply_markup) ? markupToButtons(p.reply_markup) : null;
  if (p.disable_notification === true) return null;
  return markupToButtons(d.menuFor(uid));
}

async function collect(raw: unknown): Promise<Buffer> {
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  const chunks: Buffer[] = [];
  for await (const c of raw as AsyncIterable<Uint8Array | string>) chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Байты файла из вызова Telegram: InputFile, адрес или file_id (тогда — скачать у Telegram). */
async function fileBytes(d: OutgoingDeps, prev: Prev, file: unknown, fallbackName: string): Promise<{ bytes: Buffer; name: string }> {
  // Буфер, путь к файлу, поток — InputFile сам отдаёт байты так же, как отдал бы их Telegram.
  if (file instanceof InputFile) return { bytes: await collect(await file.toRaw()), name: file.filename ?? fallbackName };
  if (typeof file === "string") {
    if (/^https?:\/\//i.test(file)) {
      const res = await fetch(file, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new TgLikeError(400, "Bad Request: failed to get HTTP URL content");
      return { bytes: Buffer.from(await res.arrayBuffer()), name: fallbackName };
    }
    const info = await prev("getFile", { file_id: file } as never);
    const path = info.ok ? (info.result as { file_path?: string }).file_path : undefined;
    if (!path) throw new TgLikeError(400, "Bad Request: wrong file identifier");
    const res = await fetch(`https://api.telegram.org/file/bot${d.botToken}/${path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new TgLikeError(400, "Bad Request: file download failed");
    return { bytes: Buffer.from(await res.arrayBuffer()), name: path.split("/").pop() || fallbackName };
  }
  throw new TgLikeError(400, "Bad Request: unsupported file");
}

async function imageAttachment(d: OutgoingDeps, prev: Prev, photo: unknown): Promise<MaxAttachment> {
  // Картинку по адресу МАКС забирает сам.
  if (typeof photo === "string" && /^https?:\/\//i.test(photo)) return { type: "image", payload: { url: photo } };
  const { bytes, name } = await fileBytes(d, prev, photo, "image.png");
  return d.api.upload("image", bytes, name);
}

async function fileAttachment(d: OutgoingDeps, prev: Prev, doc: unknown): Promise<MaxAttachment> {
  const { bytes, name } = await fileBytes(d, prev, doc, "file.bin");
  return d.api.upload("file", bytes, name);
}

/** Ответ «как Message Telegram». Без photo/document: их file_id боту хранить нельзя — он не из Telegram. */
function fakeMessage(uid: number, id: number, html: string | null, withMedia: boolean): Message {
  return { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: uid, type: "private", first_name: "" }, ...(html ? (withMedia ? { caption: html } : { text: html }) : {}) } as Message;
}

async function send(d: OutgoingDeps, uid: number, p: Payload, html: string | null, media: MaxAttachment[]): Promise<Message> {
  const maxId = d.maxIdOf(uid);
  if (maxId == null) throw new TgLikeError(400, "Bad Request: chat not found");
  const body: MaxNewMessage = { text: html, format: "html", notify: p.disable_notification !== true, attachments: [...media, ...keyboard(buttonsFor(d, uid, p))] };
  const preview = p.link_preview_options as { is_disabled?: boolean } | undefined;
  const sent = await d.api.sendMessage(maxId, body, { disableLinkPreview: preview?.is_disabled === true || p.disable_web_page_preview === true });
  const id = d.messages.remember({ mid: sent.body.mid, uid, text: html, media });
  return fakeMessage(uid, id, html, media.length > 0);
}

function stored(d: OutgoingDeps, p: Payload): StoredMaxMessage & { id: number } {
  const id = Number(p.message_id);
  const m = d.messages.get(id);
  if (!m) throw new TgLikeError(400, "Bad Request: message to edit not found");
  return { ...m, id };
}

async function edit(d: OutgoingDeps, msg: StoredMaxMessage & { id: number }, html: string | null, media: MaxAttachment[], markup: unknown): Promise<true> {
  const buttons = hasOwnMarkup(markup) ? markupToButtons(markup) : null;
  await d.api.editMessage(msg.mid, { text: html, format: "html", attachments: [...media, ...keyboard(buttons)] });
  d.messages.remember({ ...msg, text: html, media });
  return true;
}

/** Копия сообщения в чат человека из МАКС: из Telegram — по снимку, из МАКС — по памяти моста. */
async function copyToMax(d: OutgoingDeps, prev: Prev, uid: number, p: Payload): Promise<Message> {
  const fromChat = p.from_chat_id;
  const messageId = Number(p.message_id);
  if (isMaxChat(fromChat)) {
    const src = d.messages.get(messageId);
    if (!src) throw new TgLikeError(400, "Bad Request: message to copy not found");
    return send(d, uid, p, src.text, src.media);
  }
  const snap = typeof fromChat === "number" ? d.snapshots.get(fromChat, messageId) : null;
  if (!snap) throw new TgLikeError(400, "Bad Request: message to copy not found");
  const media: MaxAttachment[] = [];
  if (snap.photoFileId) media.push(await imageAttachment(d, prev, snap.photoFileId));
  if (snap.documentFileId) media.push(await fileAttachment(d, prev, snap.documentFileId));
  return send(d, uid, p, snap.html, media);
}

/**
 * Сообщение человека из МАКС → в Telegram (обращение в поддержку, предложенная
 * новость). Переслать его Telegram не может: присылаем текст и картинку заново.
 */
async function copyFromMax(d: OutgoingDeps, prev: Prev, chatId: unknown, messageId: number, signal: Signal): Promise<number | null> {
  const src = d.messages.get(messageId);
  if (!src) return null;
  // Текст в памяти моста — уже HTML (входящий экранирован), поэтому parse_mode HTML.
  const caption = src.text && captionFits(src.text) ? src.text : undefined;
  for (const url of src.imageUrls ?? []) {
    const res = await prev("sendPhoto", { chat_id: chatId, photo: url, ...(caption ? { caption, parse_mode: "HTML" } : {}) } as never, signal);
    if (res.ok) {
      if (src.text && !caption) await prev("sendMessage", { chat_id: chatId, text: src.text, parse_mode: "HTML" } as never, signal);
      return (res.result as Message).message_id;
    }
  }
  const text = src.text || ((src.imageUrls?.length ?? 0) || src.media.length ? "[вложение из МАКС — переслать в Telegram не удалось]" : "");
  if (!text) return null;
  const res = await prev("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" } as never, signal);
  return res.ok ? (res.result as Message).message_id : null;
}

async function toMax(d: OutgoingDeps, prev: Prev, method: string, p: Payload): Promise<unknown> {
  const uid = p.chat_id as number;
  switch (method) {
    case "sendMessage":
      return send(d, uid, p, htmlOf(d, p.text, p.parse_mode, p.entities), []);
    case "sendPhoto":
      return send(d, uid, p, htmlOf(d, p.caption, p.parse_mode, p.caption_entities), [await imageAttachment(d, prev, p.photo)]);
    case "sendDocument":
      return send(d, uid, p, htmlOf(d, p.caption, p.parse_mode, p.caption_entities), [await fileAttachment(d, prev, p.document)]);
    case "sendMediaGroup": {
      // Альбом — одно сообщение МАКС с несколькими картинками; подпись — от первой.
      const items = (p.media as Array<Payload>) ?? [];
      const media: MaxAttachment[] = [];
      for (const it of items) media.push(it.type === "photo" ? await imageAttachment(d, prev, it.media) : await fileAttachment(d, prev, it.media));
      const first = items.find((it) => typeof it.caption === "string" && it.caption);
      const msg = await send(d, uid, { ...p, reply_markup: { remove_keyboard: true } }, first ? htmlOf(d, first.caption, first.parse_mode, first.caption_entities) : null, media);
      return items.map(() => msg);
    }
    case "editMessageText": {
      const msg = stored(d, p);
      // Как Telegram: у фото нет текста — правят подпись, а бот в ответ шлёт новое сообщение.
      if (msg.media.length) throw new TgLikeError(400, "Bad Request: there is no text in the message to edit");
      return edit(d, msg, htmlOf(d, p.text, p.parse_mode, p.entities), [], p.reply_markup);
    }
    case "editMessageCaption": {
      const msg = stored(d, p);
      return edit(d, msg, htmlOf(d, p.caption, p.parse_mode, p.caption_entities), msg.media, p.reply_markup);
    }
    case "editMessageMedia": {
      const msg = stored(d, p);
      const m = p.media as Payload;
      const att = m.type === "photo" ? await imageAttachment(d, prev, m.media) : await fileAttachment(d, prev, m.media);
      return edit(d, msg, htmlOf(d, m.caption, m.parse_mode, m.caption_entities), [att], p.reply_markup);
    }
    case "editMessageReplyMarkup": {
      const msg = stored(d, p);
      return edit(d, msg, msg.text, msg.media, p.reply_markup);
    }
    case "deleteMessage": {
      const msg = stored(d, p);
      await d.api.deleteMessage(msg.mid);
      d.messages.forget(msg.id);
      return true;
    }
    case "copyMessage": {
      const msg = await copyToMax(d, prev, uid, p);
      return { message_id: msg.message_id };
    }
    case "forwardMessage":
      return copyToMax(d, prev, uid, p);
    case "copyMessages": {
      const ids = (p.message_ids as number[]) ?? [];
      const out: Array<{ message_id: number }> = [];
      for (const id of ids) {
        try {
          out.push({ message_id: (await copyToMax(d, prev, uid, { ...p, message_id: id })).message_id });
        } catch (err) {
          if (!(err instanceof TgLikeError) || err.code !== 400) throw err;
        }
      }
      return out;
    }
    // «Печатает…» — у МАКС действие привязано к id диалога, которого у бота нет; без него не страшно.
    case "sendChatAction":
      return true;
    default:
      throw unsupported(method);
  }
}

export function maxTransformer(d: OutgoingDeps): Transformer {
  return async (prev, method, payload, signal) => {
    const p = payload as Payload;
    try {
      // Нажатие кнопки в МАКС: всплывашка — только если боту есть что сказать.
      if (method === "answerCallbackQuery" && typeof p.callback_query_id === "string" && p.callback_query_id.startsWith(MAX_CALLBACK_PREFIX)) {
        if (typeof p.text === "string" && p.text) await d.api.answerCallback(p.callback_query_id.slice(MAX_CALLBACK_PREFIX.length), p.text);
        return { ok: true, result: true as never };
      }
      // Из МАКС в Telegram (обращение в поддержку админу, новость в медиа-ВИШ).
      if (isMaxChat(p.from_chat_id) && !isMaxChat(p.chat_id) && (method === "copyMessage" || method === "forwardMessage" || method === "copyMessages")) {
        const ids = method === "copyMessages" ? ((p.message_ids as number[]) ?? []) : [Number(p.message_id)];
        const out: number[] = [];
        for (const id of ids) {
          const sent = await copyFromMax(d, prev, p.chat_id, id, signal);
          if (sent != null) out.push(sent);
        }
        if (method === "copyMessages") return { ok: true, result: out.map((message_id) => ({ message_id })) as never };
        if (!out.length) throw new TgLikeError(400, "Bad Request: message to copy not found");
        return { ok: true, result: (method === "copyMessage" ? { message_id: out[0] } : { message_id: out[0], date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id, type: "private" } }) as never };
      }
      if (!isMaxChat(p.chat_id)) return prev(method, payload, signal);
      return { ok: true, result: (await toMax(d, prev, method, p)) as never };
    } catch (err) {
      const e = toTgError(err);
      if (e.code !== 400) logger.warn({ method, code: e.code, err: err instanceof MaxApiError ? `${err.status} ${err.code}` : String(err).slice(0, 120) }, "MAX call failed");
      return { ok: false, error_code: e.code, description: e.description, ...(e.retryAfter ? { parameters: { retry_after: e.retryAfter } } : {}) };
    }
  };
}

