/**
 * Прислать готовый PDF со слайдами в текущий чат (в ту же тему): по file_id,
 * если он уже уходил в Telegram, иначе файлом с диска — и запомнить file_id на
 * будущее. Общий для «скинь слайды» в групповом чате, «слайды …» в личке и
 * кнопки «📎 Слайды» под расписанием.
 */
import { InputFile } from "grammy";
import { readFileSync } from "node:fs";
import type { BotContext } from "./context.js";
import { plural } from "../schedule/format.js";
import { fmtDDMM } from "../time.js";
import { deckFileName, deckPartLabel } from "../notify/deckName.js";
import { logger } from "../logger.js";

export interface DeckToSend {
  id: number;
  subject: string;
  date: string;
  file: string;
  fileId: string | null;
  slides: number;
  /** Тема; по ней видно, что это часть большого PDF. */
  title?: string | null;
}

export async function sendDeck(ctx: BotContext, deck: DeckToSend): Promise<void> {
  let doc: string | InputFile;
  try {
    doc = deck.fileId ?? new InputFile(readFileSync(deck.file), deckFileName(deck));
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200), deck: deck.id }, "deck file unreadable");
    await ctx.reply("Файл этой записи у меня потерялся 😔").catch(() => undefined);
    return;
  }
  try {
    const sent = await ctx.replyWithDocument(doc, { caption: `📎 ${deck.subject} · ${fmtDDMM(deck.date)}${deckPartLabel(deck.title)} · ${deck.slides} ${plural(deck.slides, "слайд", "слайда", "слайдов")}` });
    // Только file_id: отметку «разослано» и число получателей ставит рассылка.
    if (!deck.fileId && sent.document?.file_id) ctx.deps.repo.setDeckFileId(deck.id, sent.document.file_id);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200), deck: deck.id }, "deck send failed");
    await ctx.reply("Не смог отправить файл, попробуй позже 🙂").catch(() => undefined);
  }
}
