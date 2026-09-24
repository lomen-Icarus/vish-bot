/**
 * Недавние сообщения группового чата — контекст для болталки.
 *
 * Только в памяти и только последние N за последние часы: чужую переписку бот
 * на диск не пишет. После перезапуска контекст начинается заново — свои ответы
 * конкретному человеку бот всё равно помнит по журналу chat_log.
 *
 * Если у бота включён privacy mode, Telegram присылает ему только обращения к
 * нему самому — тогда здесь будут только они, и это тоже нормально.
 */
export interface ChatLine {
  at: number;
  /** Автор; null — сам бот. */
  userId: number | null;
  name: string;
  text: string;
  /** Реплика обращена к боту (он на неё ответил или ответит). */
  addressed?: boolean;
  /** Для ответов бота: кому он отвечал. */
  toUserId?: number | null;
}

/** Реплики старше этого — уже другой разговор. */
const TTL_MS = 3 * 60 * 60_000;
/** Длинные сообщения режем: контексту хватает начала. */
const MAX_TEXT = 400;

export class ChatMemory {
  private readonly chats = new Map<number, ChatLine[]>();

  constructor(private readonly size: number) {}

  push(chatId: number, line: ChatLine): void {
    if (this.size <= 0) return;
    const list = this.chats.get(chatId) ?? [];
    list.push({ ...line, text: line.text.length > MAX_TEXT ? `${line.text.slice(0, MAX_TEXT)}…` : line.text });
    while (list.length > this.size) list.shift();
    this.chats.set(chatId, list);
  }

  recent(chatId: number, now = Date.now()): ChatLine[] {
    const list = this.chats.get(chatId);
    if (!list) return [];
    const fresh = list.filter((l) => now - l.at < TTL_MS);
    if (fresh.length !== list.length) this.chats.set(chatId, fresh);
    return [...fresh];
  }
}
