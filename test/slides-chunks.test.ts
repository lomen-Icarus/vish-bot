import { afterAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer, type SlideDeckUpload } from "../src/http/server.js";
import type { ScheduleService } from "../src/schedule/service.js";
import { PART_BYTES, uploadDeck } from "../recorder/src/upload.js";

const TOKEN = "t".repeat(24);
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

/** Как nginx хостинга: тело больше лимита (по умолчанию у nginx 1 МиБ) — 413, до бота не доходит. */
async function strictProxy(target: number, limit = 1024 * 1024): Promise<{ port: number; biggest: () => number; requests: () => number }> {
  let biggest = 0;
  let count = 0;
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      count++;
      biggest = Math.max(biggest, body.length);
      if (body.length > limit) return void res.writeHead(413).end("413 Request Entity Too Large");
      const up = request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.end(body);
    });
  });
  return { port: await listen(proxy), biggest: () => biggest, requests: () => count };
}

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "vish-chunks-"));
  const got: SlideDeckUpload[] = [];
  const bot = createHttpServer({ repo: new Repo(openDatabase(":memory:")), service: { groups: () => [] } as unknown as ScheduleService, port: 0, host: "127.0.0.1", slidesToken: TOKEN, slidesDir: dir, onSlides: (d) => got.push(d) });
  servers.push(bot);
  await once(bot, "listening");
  const botPort = (bot.address() as { port: number }).port;
  const proxy = await strictProxy(botPort);
  const wide = await strictProxy(botPort, 50 * 1024 * 1024);
  return { dir, got, botPort, proxy, wide };
}

const meta = Buffer.from(JSON.stringify({ date: "2026-09-29", subject: "Правоведение", teacher: "Кожина Т. Н.", groups: ["ВИШ-12-23"], slides: 42 })).toString("base64");
const fakePdf = (bytes: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(bytes - 9)]);

describe("слайды кусками: прокси перед ботом режет всё больше 1 МБ", () => {
  it("лимит 50 МБ (как сейчас у хостинга): PDF на 2,5 МБ уходит одним запросом", async () => {
    const { got, wide } = await setup();
    const pdf = fakePdf(2_500_000);
    const before = wide.requests();
    expect(await uploadDeck({ url: `http://127.0.0.1:${wide.port}/slides`, token: TOKEN, pdf, meta, retryDelayMs: 1 })).toBe(true);
    expect(wide.requests() - before).toBe(1);
    expect(got).toHaveLength(1);
    expect(createHash("sha256").update(readFileSync(got[0]!.file)).digest("hex")).toBe(createHash("sha256").update(pdf).digest("hex"));
  });

  it("лимит вернули к 1 МБ: целиком 413 — и PDF сам уходит кусками, доходит байт в байт", async () => {
    const { dir, got, proxy } = await setup();
    const pdf = fakePdf(2_500_000);
    const before = proxy.requests();
    expect(await uploadDeck({ url: `http://127.0.0.1:${proxy.port}/slides`, token: TOKEN, pdf, meta, retryDelayMs: 1 })).toBe(true);
    // Одна попытка целиком (413), затем куски и сборка.
    expect(proxy.requests() - before).toBe(1 + Math.ceil(pdf.length / PART_BYTES) + 1);
    expect(proxy.biggest()).toBe(pdf.length);
    expect(got).toHaveLength(1);
    expect(got[0]!.bytes).toBe(pdf.length);
    expect(createHash("sha256").update(readFileSync(got[0]!.file)).digest("hex")).toBe(createHash("sha256").update(pdf).digest("hex"));
    // Недокачанных кусков после сборки не остаётся.
    expect(existsSync(path.join(dir, ".parts")) ? readdirSync(path.join(dir, ".parts")) : []).toEqual([]);
  });

  it("маленький PDF — одним запросом, как раньше", async () => {
    const { got, proxy } = await setup();
    const before = proxy.requests();
    expect(await uploadDeck({ url: `http://127.0.0.1:${proxy.port}/slides/`, token: TOKEN, pdf: fakePdf(300_000), meta, retryDelayMs: 1 })).toBe(true);
    expect(proxy.requests() - before).toBe(1);
    expect(got).toHaveLength(1);
  });

  it("бот проверяет куски: токен, id, размер, пропуски и контрольную сумму", async () => {
    const { botPort, got } = await setup();
    const post = (p: string, headers: Record<string, string>, body?: Buffer) => fetch(`http://127.0.0.1:${botPort}${p}`, { method: "POST", headers, body });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const id = "a".repeat(32);
    expect((await post("/slides/part", { Authorization: "Bearer nope", "X-Upload-Id": id, "X-Part-Index": "0" }, Buffer.from("x"))).status).toBe(403);
    expect((await post("/slides/part", { ...auth, "X-Upload-Id": "../../etc", "X-Part-Index": "0" }, Buffer.from("x"))).status).toBe(400);
    expect((await post("/slides/part", { ...auth, "X-Upload-Id": id, "X-Part-Index": "-1" }, Buffer.from("x"))).status).toBe(400);
    // Кусок больше 1 МиБ бот не дочитывает: 413 и обрыв соединения (защита от раздувания памяти).
    const huge = await post("/slides/part", { ...auth, "X-Upload-Id": id, "X-Part-Index": "0" }, Buffer.alloc(1024 * 1024 + 1)).then((r) => r.status, () => "обрыв");
    expect([413, "обрыв"]).toContain(huge);
    const pdf = fakePdf(2000);
    expect((await post("/slides/part", { ...auth, "X-Upload-Id": id, "X-Part-Index": "0" }, pdf.subarray(0, 1000))).status).toBe(200);
    const sha = createHash("sha256").update(pdf).digest("hex");
    const complete = (extra: Record<string, string>) => post("/slides/complete", { ...auth, "X-Upload-Id": id, "X-Part-Count": "2", "X-Sha256": sha, "X-Slides-Meta": meta, ...extra });
    // Второго куска нет — 409, записывалка перешлёт.
    expect((await complete({})).status).toBe(409);
    expect((await post("/slides/part", { ...auth, "X-Upload-Id": id, "X-Part-Index": "1" }, Buffer.from("испорчено"))).status).toBe(200);
    expect((await complete({})).status).toBe(422);
    expect(got).toHaveLength(0);
    // После неудачной суммы куски стёрты — повтор начинается с чистого листа.
    expect((await complete({})).status).toBe(409);
  });
});
