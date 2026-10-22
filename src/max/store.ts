/**
 * Память моста МАКС ⇄ Telegram. Весь бот думает в терминах Telegram: чат —
 * число, сообщение — число. У МАКС сообщение — строка «mid…», поэтому мост
 * выдаёт сообщениям МАКС свои номера и помнит, что в них лежит: чтобы сменить
 * кнопки под картинкой, МАКС нужно прислать и картинку, и текст заново.
 * Живёт в памяти: после перезапуска номер выдаётся заново при первом нажатии
 * кнопки (в нажатии МАКС присылает само сообщение).
 */
import type { MaxAttachment } from "./api.js";

/**
 * Внутренние uid людей из МАКС начинаются с 2^52: Telegram обещает id чатов
 * не длиннее 52 бит, поэтому uid не совпадёт ни с человеком, ни с группой.
 */
export const MAX_UID_BASE = 2 ** 52;

/** Это чат человека из МАКС (uid моста), а не Telegram. */
export function isMaxChat(chatId: unknown): chatId is number {
  return typeof chatId === "number" && chatId > MAX_UID_BASE;
}

export interface StoredMaxMessage {
  mid: string;
  uid: number;
  /** Текст в HTML — в том виде, в каком его можно прислать в МАКС или Telegram заново. */
  text: string | null;
  /** Картинки и файлы сообщения — в том виде, в каком их можно прислать заново. */
  media: MaxAttachment[];
  /** Адреса картинок входящего сообщения: по ним картинку можно переслать в Telegram (обращение в поддержку). */
  imageUrls?: string[];
  /** Экран — ответ на действие человека: нажатие кнопки под ним меняет его самого (screen.ts). Уведомление — нет. */
  screen?: boolean;
}

/** Номер сообщения для бота ⇄ mid в МАКС; самые старые забываются. */
export class MaxMessageStore {
  private next = 1;
  private readonly byId = new Map<number, StoredMaxMessage>();
  private readonly byMid = new Map<string, number>();

  constructor(private readonly limit = 5000) {}

  /** Номер для mid: тот же, если сообщение уже встречалось; содержимое обновляется. */
  remember(msg: StoredMaxMessage): number {
    const known = this.byMid.get(msg.mid);
    const id = known ?? this.next++;
    this.byId.delete(id);
    this.byId.set(id, msg);
    this.byMid.set(msg.mid, id);
    while (this.byId.size > this.limit) {
      const [oldId, old] = this.byId.entries().next().value as [number, StoredMaxMessage];
      this.byId.delete(oldId);
      this.byMid.delete(old.mid);
    }
    return id;
  }

  /** Номер уже известного mid (без перезаписи содержимого). */
  idOf(mid: string): number | null {
    return this.byMid.get(mid) ?? null;
  }

  get(id: number): StoredMaxMessage | null {
    return this.byId.get(id) ?? null;
  }

  forget(id: number): void {
    const m = this.byId.get(id);
    if (!m) return;
    this.byId.delete(id);
    this.byMid.delete(m.mid);
  }
}

/**
 * Что было в сообщении Telegram, которое бот потом копирует людям из МАКС
 * (рассылка админа, новость канала, ответ поддержки): переслать сообщение
 * Telegram в МАКС нельзя, поэтому мост запоминает его текст и картинку.
 * Только в памяти, недолго и немного.
 */
export interface TgSnapshot {
  /** Текст или подпись уже в HTML. */
  html: string | null;
  /** file_id самой большой картинки или документа. */
  photoFileId?: string;
  documentFileId?: string;
  documentName?: string;
  at: number;
}

export class TgSnapshotStore {
  private readonly items = new Map<string, TgSnapshot>();

  constructor(
    private readonly limit = 500,
    private readonly ttlMs = 60 * 60_000,
  ) {}

  put(chatId: number, messageId: number, snap: Omit<TgSnapshot, "at">, now = Date.now()): void {
    const key = `${chatId}:${messageId}`;
    this.items.delete(key);
    this.items.set(key, { ...snap, at: now });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value as string);
  }

  get(chatId: number, messageId: number, now = Date.now()): TgSnapshot | null {
    const s = this.items.get(`${chatId}:${messageId}`);
    if (!s || now - s.at > this.ttlMs) return null;
    return s;
  }
}
