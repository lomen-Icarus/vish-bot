/**
 * Что делать с отснятыми слайдами: собрать PDF и отдать боту.
 * Бот уже знает, кому их разослать, — здесь только доставка.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deckBaseName } from "./plan.js";
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
      if (await deliver({ url, token, pdf: readFileSync(pdfPath), meta, slides })) {
        rmSync(marker, { force: true });
        sent++;
      }
    } catch (err) {
      log.warn({ err: String(err), file: name }, "повторная отправка слайдов не удалась");
    }
  }
  return sent;
}
