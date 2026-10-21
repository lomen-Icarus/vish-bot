/**
 * События МАКС → обновления Telegram. Бот целиком написан под Telegram, поэтому
 * мост не копирует его, а переводит: сообщение человека в МАКС становится
 * сообщением в личке Telegram от «человека» с uid моста, нажатие кнопки —
 * callback_query. Дальше работают те же обработчики, что и в Telegram.
 * Только личные диалоги: групповых чатов МАКС мост не касается.
 */
import type { Message, Update, User as TgUser } from "grammy/types";
import type { MaxAttachment, MaxIncomingAttachment, MaxMessage, MaxUpdate, MaxUser } from "./api.js";
import { esc } from "../schedule/format.js";
import type { MaxMessageStore } from "./store.js";

export interface IncomingDeps {
  /** uid моста по id МАКС (выдаёт база, см. Repo.maxUid). */
  uid: (maxId: number) => number;
  messages: MaxMessageStore;
  /** Сам бот в Telegram — отправитель «своих» сообщений в callback_query. */
  bot: TgUser;
}

/** Метка id нажатия: по ней answerCallbackQuery понимает, что это кнопка в МАКС. */
export const MAX_CALLBACK_PREFIX = "max:";

/** Время МАКС — в миллисекундах, у Telegram — в секундах. */
const seconds = (ts: number): number => Math.floor(ts > 1e12 ? ts / 1000 : ts);

function tgUser(u: MaxUser, uid: number): TgUser {
  const first = (u.first_name || u.name || "").trim() || "Гость";
  // Ника из МАКС у «человека» нет нарочно: по нику бот узнаёт старост и
  // преподавателей из реестров Telegram — тёзка в МАКС не должен стать ими.
  return { id: uid, is_bot: false, first_name: first, ...(u.last_name ? { last_name: u.last_name } : {}) };
}

/** Вложения входящего сообщения МАКС: что можно прислать заново и адреса картинок. */
function incomingMedia(atts: MaxIncomingAttachment[] | null | undefined): { media: MaxAttachment[]; imageUrls: string[] } {
  const media: MaxAttachment[] = [];
  const imageUrls: string[] = [];
  for (const a of atts ?? []) {
    const token = a.payload?.token;
    if (a.type === "image") {
      if (token) media.push({ type: "image", payload: { token } });
      if (a.payload?.url) imageUrls.push(a.payload.url);
    } else if (a.type === "file" && token) {
      media.push({ type: "file", payload: { token } });
    }
  }
  return { media, imageUrls };
}

/**
 * Сообщение МАКС → Message Telegram (с номером из памяти моста). Своё
 * сообщение бота, которое мост уже помнит (нажали кнопку под ним), не
 * перезаписываем: в памяти оно с разметкой, а МАКС присылает голый текст.
 */
function tgMessage(msg: MaxMessage, uid: number, from: TgUser, d: IncomingDeps, own = false): Message {
  const { media, imageUrls } = incomingMedia(msg.body.attachments);
  const text = msg.body.text ?? "";
  const known = own ? d.messages.idOf(msg.body.mid) : null;
  const id = known ?? d.messages.remember({ mid: msg.body.mid, uid, text: text ? esc(text) : null, media, imageUrls });
  const chat = { id: uid, type: "private" as const, first_name: from.first_name };
  const base = { message_id: id, date: seconds(msg.timestamp), chat, from };
  // Картинка — как фото Telegram с подписью: по этому бот понимает, что листает постер.
  if (media.some((m) => m.type === "image")) {
    return { ...base, photo: [{ file_id: `max:${msg.body.mid}`, file_unique_id: msg.body.mid, width: 1, height: 1 }], ...(text ? { caption: text } : {}) } as Message;
  }
  return { ...base, text, ...commandEntity(text) } as Message;
}

/** Команде нужна разметка bot_command — по ней grammY узнаёт /today и /start. */
function commandEntity(text: string): { entities?: Message["entities"] } {
  const m = /^\/[A-Za-z0-9_]+/.exec(text);
  return m ? { entities: [{ type: "bot_command", offset: 0, length: m[0].length }] } : {};
}

/** null — событие не для бота (группа, бот, служебное). */
export function toTelegramUpdate(u: MaxUpdate, updateId: number, d: IncomingDeps): Update | null {
  if (u.update_type === "message_created") {
    const msg = (u as Extract<MaxUpdate, { update_type: "message_created" }>).message;
    if (msg.recipient.chat_type !== "dialog" || !msg.sender || msg.sender.is_bot) return null;
    const uid = d.uid(msg.sender.user_id);
    return { update_id: updateId, message: tgMessage(msg, uid, tgUser(msg.sender, uid), d) } as Update;
  }
  if (u.update_type === "message_callback") {
    const ev = u as Extract<MaxUpdate, { update_type: "message_callback" }>;
    const uid = d.uid(ev.callback.user.user_id);
    const from = tgUser(ev.callback.user, uid);
    const message = ev.message ? { ...tgMessage(ev.message, uid, d.bot, d, true), chat: { id: uid, type: "private" as const, first_name: from.first_name } } : undefined;
    return {
      update_id: updateId,
      callback_query: {
        id: `${MAX_CALLBACK_PREFIX}${ev.callback.callback_id}`,
        from,
        chat_instance: String(uid),
        ...(ev.callback.payload ? { data: ev.callback.payload } : {}),
        ...(message ? { message } : {}),
      },
    } as Update;
  }
  if (u.update_type === "bot_started") {
    // «Начать» в МАКС — тот же /start; параметр ссылки max.ru/бот?start=… — после пробела.
    const ev = u as Extract<MaxUpdate, { update_type: "bot_started" }>;
    const uid = d.uid(ev.user.user_id);
    const from = tgUser(ev.user, uid);
    const text = ev.payload ? `/start ${ev.payload}` : "/start";
    const id = d.messages.remember({ mid: `started:${uid}:${ev.timestamp}`, uid, text, media: [] });
    return { update_id: updateId, message: { message_id: id, date: seconds(ev.timestamp), chat: { id: uid, type: "private", first_name: from.first_name }, from, text, ...commandEntity(text) } } as Update;
  }
  return null;
}

/** Остановил бота в МАКС — как «заблокировал» в Telegram. */
export function stoppedUid(u: MaxUpdate, uid: (maxId: number) => number): number | null {
  if (u.update_type !== "bot_stopped") return null;
  const user = (u as Extract<MaxUpdate, { update_type: "bot_stopped" }>).user;
  return user ? uid(user.user_id) : null;
}

