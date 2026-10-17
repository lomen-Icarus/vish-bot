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
      // Без пути: в имени папки — фамилия преподавателя, а в логах имён быть не должно.
      log.warn({ err: (err as Error).name, frame: path.basename(file) }, "кадр не влез в PDF, пропускаю");
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
export async function deliver(opts: { urls: string[]; token: string; pdf: Buffer; meta: DeckMeta; slides: number }): Promise<boolean> {
  const urls = opts.urls.filter(Boolean);
  if (!urls.length || !opts.token) {
    log.warn({}, "BOT_SLIDES_URL/SLIDES_TOKEN не заданы: PDF остаётся только на диске");
    return false;
  }
  const meta = Buffer.from(JSON.stringify({ ...opts.meta, slides: opts.slides }), "utf8").toString("base64");
  // Основной адрес и резервный: домен бота мог лечь (DNS) — тогда пробуем
  // запасной. Ответ бота (отказ, 5xx за прокси) — не повод: запасной — тот же
  // бот, и повтор только задвоил бы пачку (решение 109).
  for (let i = 0; i < urls.length; i++) {
    try {
      if (!(await uploadDeck({ url: urls[i]!, token: opts.token, pdf: opts.pdf, meta }))) return false;
      log.info({ slides: opts.slides, bytes: opts.pdf.length, via: i === 0 ? "основной" : "резерв" }, "слайды отданы боту");
      return true;
    } catch (err) {
      log.warn({ err: String(err).slice(0, 150), via: i }, "не достучался до бота со слайдами");
    }
  }
  return false;
}

/**
 * Пачки, которые сейчас отдаются боту. Повторная отправка (retryPending, раз в
 * 5 минут) их не трогает: метки частей большого PDF пишутся до отправки, и без
 * этого очередь отправляла бы те же части второй раз, пока идёт первая отправка.
 */
const inFlight = new Set<string>();

/**
 * Бот принимает PDF до 40 МиБ (Telegram пускает от бота файлы до 50 МБ). Больше
 * — делим по страницам на части с запасом: «Экономика» за 09.10 вышла 43 МБ,
 * бот рвал соединение, и запись неделю лежала в очереди.
 */
export const MAX_DECK_BYTES = 38 * 1024 * 1024;

/** PDF по страницам на части не больше limit; влезает целиком — он один и остаётся. */
export async function splitPdf(pdf: Buffer, limit = MAX_DECK_BYTES): Promise<Buffer[]> {
  return (await splitPdfPages(pdf, limit)).map((p) => p.pdf);
}

/** То же, с числом страниц в каждой части (pages: null — PDF не делили). */
async function splitPdfPages(pdf: Buffer, limit: number): Promise<Array<{ pdf: Buffer; pages: number | null }>> {
  if (pdf.length <= limit) return [{ pdf, pages: null }];
  const src = await PDFDocument.load(pdf);
  const total = src.getPageCount();
  let parts: Array<{ pdf: Buffer; pages: number | null }> = [{ pdf, pages: total }];
  for (let n = Math.max(2, Math.ceil(pdf.length / limit)); n <= total; n++) {
    const per = Math.ceil(total / n);
    parts = [];
    for (let from = 0; from < total; from += per) {
      const out = await PDFDocument.create();
      const idx = Array.from({ length: Math.min(per, total - from) }, (_, i) => from + i);
      for (const page of await out.copyPages(src, idx)) out.addPage(page);
      parts.push({ pdf: Buffer.from(await out.save()), pages: idx.length });
    }
    if (parts.every((p) => p.pdf.length <= limit)) break;
  }
  return parts;
}

/**
 * Большой PDF — частями, каждая отдельным файлом со своей меткой «не принят»:
 * принятая часть при повторе второй раз не уходит. Возвращает, что отправлять.
 */
export async function splitDeckFile(pdfPath: string, pdf: Buffer, meta: DeckMeta, slides: number, limit = MAX_DECK_BYTES): Promise<Array<{ pdfPath: string; pdf: Buffer; meta: DeckMeta; slides: number }>> {
  const parts = await splitPdfPages(pdf, limit);
  if (parts.length === 1) return [{ pdfPath, pdf, meta, slides }];
  const base = pdfPath.replace(/\.pdf$/i, "");
  // Слайдов в части — сколько в ней страниц (кадр = страница).
  const out = parts.map((part, i) => {
    const partPath = `${base}-часть-${i + 1}.pdf`;
    const partMeta = { ...meta, title: `${meta.title ? `${meta.title} · ` : ""}часть ${i + 1} из ${parts.length}` };
    return { pdfPath: partPath, pdf: part.pdf, meta: partMeta, slides: part.pages ?? slides };
  });
  for (const p of out) {
    // «Занята» — до метки «не принята»: иначе повторная отправка подхватила бы
    // ещё не начатые части, пока идёт первая.
    inFlight.add(p.pdfPath);
    writeFileSync(p.pdfPath, p.pdf);
    savePending(p.pdfPath, p.meta, p.slides);
  }
  rmSync(`${pdfPath}${PENDING}`, { force: true });
  log.info({ bytes: pdf.length, parts: out.length, slides }, "PDF больше лимита бота — делю на части");
  return out;
}

/** Отдать боту PDF с диска (большой — частями); что не принято — останется в очереди. */
export async function deliverDeck(opts: { urls: string[]; token: string; pdfPath: string; pdf: Buffer; meta: DeckMeta; slides: number; limit?: number }): Promise<number> {
  let sent = 0;
  let parts: Awaited<ReturnType<typeof splitDeckFile>> = [];
  inFlight.add(opts.pdfPath);
  try {
    parts = await splitDeckFile(opts.pdfPath, opts.pdf, opts.meta, opts.slides, opts.limit);
    for (const part of parts) inFlight.add(part.pdfPath);
    for (const part of parts) {
      if (await deliver({ urls: opts.urls, token: opts.token, pdf: part.pdf, meta: part.meta, slides: part.slides })) {
        rmSync(`${part.pdfPath}${PENDING}`, { force: true });
        sent++;
      } else {
        savePending(part.pdfPath, part.meta, part.slides);
      }
    }
  } finally {
    inFlight.delete(opts.pdfPath);
    for (const part of parts) inFlight.delete(part.pdfPath);
  }
  return sent;
}

/**
 * Кадры, снятые раньше в этой же паре. Папка кадров живёт на диске, а PDF
 * собирается только в конце пары, поэтому перезапуск записывалки посреди пары
 * (деплой, правка .env) раньше стирал всё снятое до него. Теперь: PDF этой
 * пары ещё нет — значит, съёмку прервали, и кадры остаются, съёмка дописывает
 * к ним; PDF уже есть — пачка собрана и отдана, папку чистим, как раньше
 * (иначе повторный заход отправил бы те же слайды второй раз).
 */
export function earlierSlides(dir: string, pdfPath: string): string[] {
  if (existsSync(pdfPath)) {
    rmSync(dir, { recursive: true, force: true });
    return [];
  }
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => path.join(dir, f));
}

/** Имя PDF: дата, время начала и предмет — две пары одного предмета в день не затирают друг друга. */
export function deckFileName(meta: DeckMeta): string {
  return `${deckBaseName(meta.date, meta.startMinutes, meta.subject, meta.teacher ?? "")}.pdf`;
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
export async function retryPending(outDir: string, urls: string[], token: string): Promise<number> {
  if (!urls.filter(Boolean).length || !token || !existsSync(outDir)) return 0;
  let sent = 0;
  for (const name of readdirSync(outDir)) {
    if (!name.endsWith(PENDING)) continue;
    const marker = path.join(outDir, name);
    const pdfPath = marker.slice(0, -PENDING.length);
    if (inFlight.has(pdfPath)) continue;
    try {
      if (!existsSync(pdfPath)) {
        rmSync(marker, { force: true });
        continue;
      }
      const { meta, slides } = JSON.parse(readFileSync(marker, "utf8")) as { meta: DeckMeta; slides: number };
      sent += await deliverDeck({ urls, token, pdfPath, pdf: readFileSync(pdfPath), meta, slides });
    } catch (err) {
      log.warn({ err: (err as Error).name }, "повторная отправка слайдов не удалась");
    }
  }
  return sent;
}
