/**
 * Что делать с отснятыми слайдами: собрать PDF и отдать боту.
 * Бот уже знает, кому их разослать, — здесь только доставка.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deckBaseName } from "./plan.js";
import { PDFDocument } from "pdf-lib";
import { uploadDeck } from "./upload.js";
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
 * Отдаёт PDF боту: маленький — одним запросом, большой — кусками меньше 1 МБ
 * (прокси перед ботом больше не пропускает), см. upload.ts.
 */
export async function deliver(opts: { url: string; token: string; pdf: Buffer; meta: DeckMeta; slides: number }): Promise<boolean> {
  if (!opts.url || !opts.token) {
    log.warn({}, "BOT_SLIDES_URL/SLIDES_TOKEN не заданы: PDF остаётся только на диске");
    return false;
  }
  try {
    const ok = await uploadDeck({
      url: opts.url,
      token: opts.token,
      pdf: opts.pdf,
      meta: Buffer.from(JSON.stringify({ ...opts.meta, slides: opts.slides }), "utf8").toString("base64"),
    });
    if (ok) log.info({ slides: opts.slides, bytes: opts.pdf.length }, "слайды отданы боту");
    return ok;
  } catch (err) {
    log.warn({ err: String(err) }, "не получилось отдать слайды боту");
    return false;
  }
}

/**
 * Бот принимает PDF до 40 МиБ (Telegram пускает от бота файлы до 50 МБ). Больше
 * — делим по страницам на части с запасом: «Экономика» за 09.10 вышла 43 МБ,
 * бот рвал соединение, и запись неделю лежала в очереди.
 */
export const MAX_DECK_BYTES = 38 * 1024 * 1024;

/** PDF по страницам на части не больше limit; влезает целиком — он один и остаётся. */
export async function splitPdf(pdf: Buffer, limit = MAX_DECK_BYTES): Promise<Buffer[]> {
  if (pdf.length <= limit) return [pdf];
  const src = await PDFDocument.load(pdf);
  const total = src.getPageCount();
  let parts: Buffer[] = [pdf];
  for (let n = Math.max(2, Math.ceil(pdf.length / limit)); n <= total; n++) {
    const per = Math.ceil(total / n);
    parts = [];
    for (let from = 0; from < total; from += per) {
      const out = await PDFDocument.create();
      const idx = Array.from({ length: Math.min(per, total - from) }, (_, i) => from + i);
      for (const page of await out.copyPages(src, idx)) out.addPage(page);
      parts.push(Buffer.from(await out.save()));
    }
    if (parts.every((p) => p.length <= limit)) break;
  }
  return parts;
}

/**
 * Большой PDF — частями, каждая отдельным файлом со своей меткой «не принят»:
 * принятая часть при повторе второй раз не уходит. Возвращает, что отправлять.
 */
export async function splitDeckFile(pdfPath: string, pdf: Buffer, meta: DeckMeta, slides: number, limit = MAX_DECK_BYTES): Promise<Array<{ pdfPath: string; pdf: Buffer; meta: DeckMeta; slides: number }>> {
  const parts = await splitPdf(pdf, limit);
  if (parts.length === 1) return [{ pdfPath, pdf, meta, slides }];
  const base = pdfPath.replace(/\.pdf$/i, "");
  const out = parts.map((part, i) => {
    const partPath = `${base}-часть-${i + 1}.pdf`;
    const partMeta = { ...meta, title: `${meta.title ? `${meta.title} · ` : ""}часть ${i + 1} из ${parts.length}` };
    return { pdfPath: partPath, pdf: part, meta: partMeta, slides: 0 };
  });
  // Слайдов в части — сколько в ней страниц (кадр = страница).
  for (const p of out) {
    p.slides = (await PDFDocument.load(p.pdf)).getPageCount();
    writeFileSync(p.pdfPath, p.pdf);
    savePending(p.pdfPath, p.meta, p.slides);
  }
  rmSync(`${pdfPath}${PENDING}`, { force: true });
  log.info({ bytes: pdf.length, parts: out.length, slides }, "PDF больше лимита бота — делю на части");
  return out;
}

/** Отдать боту PDF с диска (большой — частями); что не принято — останется в очереди. */
export async function deliverDeck(opts: { url: string; token: string; pdfPath: string; pdf: Buffer; meta: DeckMeta; slides: number; limit?: number }): Promise<number> {
  let sent = 0;
  for (const part of await splitDeckFile(opts.pdfPath, opts.pdf, opts.meta, opts.slides, opts.limit)) {
    if (await deliver({ url: opts.url, token: opts.token, pdf: part.pdf, meta: part.meta, slides: part.slides })) {
      rmSync(`${part.pdfPath}${PENDING}`, { force: true });
      sent++;
    } else {
      savePending(part.pdfPath, part.meta, part.slides);
    }
  }
  return sent;
}

/** Имя PDF: дата, время начала и предмет — две пары одного предмета в день не затирают друг друга. */
export function deckFileName(meta: DeckMeta): string {
  return `${deckBaseName(meta.date, meta.startMinutes, meta.subject)}.pdf`;
}

/** Рядом с PDF, который бот не принял, лежит такая метка: её подбирает повторная отправка. */
const PENDING = ".pending.json";

export function savePending(pdfPath: string, meta: DeckMeta, slides: number): void {
  writeFileSync(`${pdfPath}${PENDING}`, JSON.stringify({ meta, slides }), "utf8");
}

/**
 * Повторно отдать боту всё, что он не принял (бот перезапускался, сеть
 * моргнула). Возвращает, сколько пачек ушло.
 */
export async function retryPending(outDir: string, url: string, token: string): Promise<number> {
  if (!url || !token || !existsSync(outDir)) return 0;
  let sent = 0;
  for (const name of readdirSync(outDir)) {
    if (!name.endsWith(PENDING)) continue;
    const marker = path.join(outDir, name);
    const pdfPath = marker.slice(0, -PENDING.length);
    try {
      if (!existsSync(pdfPath)) {
        rmSync(marker, { force: true });
        continue;
      }
      const { meta, slides } = JSON.parse(readFileSync(marker, "utf8")) as { meta: DeckMeta; slides: number };
      sent += await deliverDeck({ url, token, pdfPath, pdf: readFileSync(pdfPath), meta, slides });
    } catch (err) {
      log.warn({ err: String(err), file: name }, "повторная отправка слайдов не удалась");
    }
  }
  return sent;
}
