/**
 * Что делать с отснятыми слайдами: собрать PDF и отдать боту.
 * Бот уже знает, кому их разослать, — здесь только доставка.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { fetch as undiciFetch } from "undici";
import { log } from "./log.js";

export interface DeckMeta {
  date: string;
  subject: string;
  teacher: string;
  groups: string[];
  title: string;
  startMinutes: number | null;
  endMinutes: number | null;
}

/** Склеивает кадры в один PDF: страница на слайд, без полей. */
export async function buildPdf(files: string[], outFile: string, meta: DeckMeta): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${meta.subject} — ${meta.date}`);
  pdf.setSubject(meta.title || meta.subject);
  pdf.setAuthor(meta.teacher || "ВИШ ЧувГУ");
  pdf.setProducer("vish-bot recorder");
  for (const file of files) {
    try {
      const png = await pdf.embedPng(readFileSync(file));
      const page = pdf.addPage([png.width, png.height]);
      page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
    } catch (err) {
      log.warn({ err: String(err), file }, "кадр не влез в PDF, пропускаю");
    }
  }
  const bytes = Buffer.from(await pdf.save());
  writeFileSync(outFile, bytes);
  return bytes;
}

/**
 * Отдаёт PDF боту. Тело — сам файл, всё остальное в заголовках: так не нужен
 * multipart и не растёт память на больших пачках.
 */
export async function deliver(opts: { url: string; token: string; pdf: Buffer; meta: DeckMeta; slides: number }): Promise<boolean> {
  if (!opts.url || !opts.token) {
    log.warn({}, "BOT_SLIDES_URL/SLIDES_TOKEN не заданы: PDF остаётся только на диске");
    return false;
  }
  try {
    const res = await undiciFetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        Authorization: `Bearer ${opts.token}`,
        "X-Slides-Meta": Buffer.from(JSON.stringify({ ...opts.meta, slides: opts.slides }), "utf8").toString("base64"),
      },
      body: opts.pdf,
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status >= 200 && res.status < 300) {
      log.info({ status: res.status, slides: opts.slides }, "слайды отданы боту");
      return true;
    }
    log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, "бот не принял слайды");
    return false;
  } catch (err) {
    log.warn({ err: String(err) }, "не получилось отдать слайды боту");
    return false;
  }
}

export function deckFileName(meta: DeckMeta): string {
  const safe = meta.subject.replace(/[^\p{L}\p{N} .-]/gu, "").trim().slice(0, 60) || "вебинар";
  return path.normalize(`${meta.date}-${safe}.pdf`).replace(/[/\\]/g, "-");
}
