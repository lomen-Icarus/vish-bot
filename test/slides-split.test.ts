import { afterAll, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer, type SlideDeckUpload } from "../src/http/server.js";
import type { ScheduleService } from "../src/schedule/service.js";
import { slidesEndpoint } from "../recorder/src/upload.js";
import { deliverDeck, retryPending, splitDeckFile, splitPdfPages, type DeckMeta } from "../recorder/src/deliver.js";
import { errName } from "../recorder/src/log.js";

const TOKEN = "t".repeat(24);
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function bot() {
  const dir = mkdtempSync(path.join(tmpdir(), "vish-split-"));
  const got: SlideDeckUpload[] = [];
  const server = createHttpServer({ repo: new Repo(openDatabase(":memory:")), service: { groups: () => [] } as unknown as ScheduleService, port: 0, host: "127.0.0.1", slidesToken: TOKEN, slidesDir: dir, onSlides: (d) => got.push(d) });
  servers.push(server);
  await once(server, "listening");
  return { got, port: (server.address() as { port: number }).port };
}

/** PDF на pages страниц, каждая ~bytesPerPage (несжатый текст). */
async function makePdf(pages: number, bytesPerPage = 20_000): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([400, 300]);
    const junk = randomBytes(bytesPerPage / 2).toString("hex");
    for (let at = 0; at < junk.length; at += 200) page.drawText(junk.slice(at, at + 200), { x: 5, y: 290 - ((at / 200) % 50) * 5, size: 4, font });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const meta: DeckMeta = { date: "2026-10-09", subject: "Экономика", teacher: "Ефремова М. П.", groups: ["ВИШ-14-24"], title: "Лекция 5", startMinutes: 18 * 60 + 10, endMinutes: 19 * 60 + 30 };

describe("слайды: адрес бота без /slides", () => {
  it("путь дописывается, если его забыли; заданный путь не трогаем", () => {
    expect(slidesEndpoint("https://slides.secretvish.ru")).toBe("https://slides.secretvish.ru/slides");
    expect(slidesEndpoint("https://slides.secretvish.ru/")).toBe("https://slides.secretvish.ru/slides");
    expect(slidesEndpoint("https://slides.secretvish.ru/slides/")).toBe("https://slides.secretvish.ru/slides");
    expect(slidesEndpoint("http://host:40070/custom")).toBe("http://host:40070/custom");
  });
});

describe("слайды: PDF больше лимита бота", () => {
  it("бот на слишком большой PDF отвечает 413, а не рвёт соединение (nginx отдал бы 502)", async () => {
    const { port } = await bot();
    const body = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(41 * 1024 * 1024)]);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/slides", method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/pdf", "Content-Length": body.length } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(413);
  });

  it("splitPdfPages: части не больше лимита, страницы все и по порядку", async () => {
    const pdf = await makePdf(6);
    expect((await splitPdfPages(pdf, pdf.length + 1)).map((p) => p.pdf)).toEqual([pdf]);
    const parts = (await splitPdfPages(pdf, Math.ceil(pdf.length / 2.5))).map((p) => p.pdf);
    expect(parts.length).toBeGreaterThan(1);
    let pages = 0;
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(Math.ceil(pdf.length / 2.5));
      pages += (await PDFDocument.load(p)).getPageCount();
    }
    expect(pages).toBe(6);
  });

  it("большая запись уходит частями «часть i из N», файлы у бота не затирают друг друга, очередь пуста", async () => {
    const { got, port } = await bot();
    const out = mkdtempSync(path.join(tmpdir(), "vish-rec-"));
    const pdf = await makePdf(6);
    const pdfPath = path.join(out, "2026-10-09-1810-Экономика.pdf");
    writeFileSync(pdfPath, pdf);
    // Адрес без /slides — как был на VPS.
    const sent = await deliverDeck({ urls: [`http://127.0.0.1:${port}`], token: TOKEN, pdfPath, pdf, meta, slides: 6, limit: Math.ceil(pdf.length / 2.5) });
    expect(sent).toBe(got.length);
    expect(got.length).toBeGreaterThan(1);
    expect(got.map((d) => d.title)).toEqual(got.map((_, i) => `Лекция 5 · часть ${i + 1} из ${got.length}`));
    expect(got.reduce((n, d) => n + d.slides, 0)).toBe(6);
    expect(new Set(got.map((d) => d.file)).size).toBe(got.length);
    expect(got.every((d) => existsSync(d.file))).toBe(true);
    expect(readdirSync(out).filter((f) => f.endsWith(".pending.json"))).toEqual([]);
  });

  it("бот не принял — каждая часть остаётся в очереди и потом уходит сама; целый файл повторно не шлётся", async () => {
    const { got, port } = await bot();
    const out = mkdtempSync(path.join(tmpdir(), "vish-rec-"));
    const pdf = await makePdf(6);
    const pdfPath = path.join(out, "2026-10-09-1810-Экономика.pdf");
    writeFileSync(pdfPath, pdf);
    writeFileSync(`${pdfPath}.pending.json`, JSON.stringify({ meta, slides: 6 }));
    expect(await deliverDeck({ urls: [`http://127.0.0.1:${port}/slides`], token: "wrong-token-wrong-token", pdfPath, pdf, meta, slides: 6, limit: Math.ceil(pdf.length / 2.5) })).toBe(0);
    const pending = readdirSync(out).filter((f) => f.endsWith(".pending.json"));
    expect(pending.length).toBeGreaterThan(1);
    expect(pending.every((f) => f.includes("-часть-"))).toBe(true);
    expect(await retryPending(out, [`http://127.0.0.1:${port}/slides`], TOKEN)).toBe(pending.length);
    expect(got.length).toBe(pending.length);
    expect(readdirSync(out).filter((f) => f.endsWith(".pending.json"))).toEqual([]);
  });

  it("основной адрес недоступен — PDF уходит на резервный", async () => {
    const { got, port } = await bot();
    const out = mkdtempSync(path.join(tmpdir(), "vish-rec-"));
    const pdf = await makePdf(2);
    const pdfPath = path.join(out, "2026-10-16-0950-Экономика.pdf");
    writeFileSync(pdfPath, pdf);
    // Первый адрес — порт, где никто не слушает (как лёгший домен); второй — живой бот.
    const sent = await deliverDeck({ urls: [`http://127.0.0.1:1/slides`, `http://127.0.0.1:${port}/slides`], token: TOKEN, pdfPath, pdf, meta, slides: 2 });
    expect(sent).toBe(1);
    expect(got.length).toBe(1);
    expect(readdirSync(out).filter((f) => f.endsWith(".pending.json"))).toEqual([]);
  });

  it("запись части не удалась (диск кончился) — записанные части стёрты, в очереди целый PDF, а не половина", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "vish-rec-"));
    const pdf = await makePdf(6);
    const pdfPath = path.join(out, "2026-10-09-1810-Экономика.pdf");
    writeFileSync(pdfPath, pdf);
    // Вместо файла второй части — папка: запись падает на середине, как при ENOSPC.
    mkdirSync(path.join(out, "2026-10-09-1810-Экономика-часть-2.pdf"));
    await expect(splitDeckFile(pdfPath, pdf, meta, 6, Math.ceil(pdf.length / 2.5))).rejects.toThrow();
    const left = readdirSync(out).sort();
    expect(left).toContain("2026-10-09-1810-Экономика.pdf.pending.json");
    expect(left.filter((f) => f.includes("-часть-1"))).toEqual([]);
  });
});

describe("errName: ошибка для лога без путей", () => {
  it("путь в кавычках и с начала слова — прочь; «Мат/анализ» и код — как есть, без дубля", () => {
    const fsErr = Object.assign(new Error("ENOENT: no such file or directory, open '/out/2026-10-09-1000-Физика-Иванов-ИИ/slide-1.png'"), { code: "ENOENT" });
    expect(errName(fsErr)).toBe("ENOENT: no such file or directory, open '<путь>'");
    const spaceErr = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    expect(errName(spaceErr)).toBe("ENOSPC: no space left on device, write");
    expect(errName(new Error("нет кадров у Мат/анализ"))).toBe("Error: нет кадров у Мат/анализ");
    expect(errName(new Error("не открылась /tmp/x/y.pdf"))).toBe("Error: не открылась <путь>");
    // У DOMException код числовой — пишем имя.
    expect(errName(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe("TimeoutError: The operation was aborted due to timeout");
  });
});
