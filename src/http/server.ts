/**
 * Tiny HTTP server: personal calendar feeds (webcal subscriptions) and a
 * health probe. Plain HTTP is enough: iOS/macOS Calendar and Google Calendar
 * subscribe to http:// feeds, so the hosting's open port and domain suffice.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Repo } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import { groupCalendar } from "../schedule/calendar.js";
import { logger } from "../logger.js";

/** Сравнение секрета за постоянное время: по задержке ответа токен не подобрать. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export interface SlideDeckUpload {
  date: string;
  subject: string;
  teacher: string | null;
  title: string | null;
  groups: string[];
  slides: number;
  /** Куда записан PDF. */
  file: string;
  bytes: number;
  deckId: number;
}

export interface HttpDeps {
  repo: Repo;
  service: ScheduleService;
  port: number;
  host?: string;
  /** Токен, которым записывалка вебинаров подписывает загрузку слайдов. */
  slidesToken?: string;
  /** Куда складывать присланные PDF. */
  slidesDir?: string;
  /** Вызывается после успешной загрузки: бот рассылает слайды подписчикам. */
  onSlides?: (deck: SlideDeckUpload) => void;
}

const MAX_DECK_BYTES = 40 * 1024 * 1024;
/**
 * Загрузка кусками: прокси перед ботом (nginx хостинга) режет тело запроса
 * больше 1 МБ, а PDF лекции почти всегда больше. Записывалка шлёт PDF частями
 * (POST /slides/part), потом просит собрать (POST /slides/complete) и
 * сверяет контрольную сумму. Кусок — не больше 1 МиБ.
 */
const MAX_PART_BYTES = 1024 * 1024;
const MAX_PARTS = Math.ceil(MAX_DECK_BYTES / (512 * 1024));
/** Недокачанные загрузки старше суток удаляются. */
const STALE_PARTS_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ID = /^[a-f0-9]{16,64}$/;

/** Читает тело запроса целиком, с жёстким потолком по размеру. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const FEED_CACHE_MS = 5 * 60_000;
/** A semester feed is ~100 KB, so the cache stays small on a 2 GB container. */
const MAX_CACHE_ENTRIES = 50;

export function calendarPath(token: string): string {
  return `/cal/${token}.ics`;
}

export function createHttpServer(deps: HttpDeps): Server {
  const cache = new Map<string, { at: number; body: Buffer }>();

  const feed = (token: string): { status: number; body: Buffer; type: string } => {
    // A user who blocked the bot in Telegram still keeps their calendar subscription.
    const user = deps.repo.userByCalToken(token);
    if (!user) return { status: 404, body: Buffer.from("not found"), type: "text/plain; charset=utf-8" };
    const group = user.groupKey ? deps.service.group(user.groupKey) : null;
    if (!group) return { status: 404, body: Buffer.from("group not chosen"), type: "text/plain; charset=utf-8" };
    // Cache key changes whenever the user's settings or the portal data change, so a fresh feed is never stale.
    const key = [token, group.key, user.subgroup ?? "", user.calAlarmMin ?? "", deps.repo.lastPollRun()?.finishedAt ?? ""].join("|");
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= FEED_CACHE_MS) cache.delete(k);
    const hit = cache.get(key);
    if (hit) return { status: 200, body: hit.body, type: "text/calendar; charset=utf-8" };
    const { ics } = groupCalendar(deps.service, group, { subgroup: user.subgroup, alarmMinutes: user.calAlarmMin, refreshInterval: "PT1H", stableSequence: true });
    for (const k of cache.keys()) if (k.startsWith(`${token}|`)) cache.delete(k);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    const body = Buffer.from(ics, "utf8");
    cache.set(key, { at: now, body });
    return { status: 200, body, type: "text/calendar; charset=utf-8" };
  };

  const slidesDir = (): string => deps.slidesDir ?? "./data/slides";
  const partsDir = (id: string): string => path.join(slidesDir(), ".parts", id);

  /** Принять готовый PDF: сохранить, записать в базу, отдать рассылке. Общая часть для целого файла и собранного из кусков. */
  const acceptDeck = (metaHeader: string | string[] | undefined, body: Buffer): { status: number; text: string } => {
    const meta = JSON.parse(Buffer.from(String(metaHeader ?? ""), "base64").toString("utf8")) as Partial<SlideDeckUpload> & { slides?: number };
    if (!meta.date || !meta.subject) return { status: 400, text: "в X-Slides-Meta нужны date и subject" };
    // Дата уходит в подпись и в имя файла: принимаем только YYYY-MM-DD.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.date))) return { status: 400, text: "date должна быть в формате YYYY-MM-DD" };
    if (!body.length || body.subarray(0, 4).toString() !== "%PDF") return { status: 400, text: "тело должно быть PDF" };
    const dir = slidesDir();
    mkdirSync(dir, { recursive: true });
    // В один день по одному предмету бывает две пары у разных потоков —
    // без времени в имени вторая затирала бы первую.
    const stamp = new Date().toISOString().slice(11, 16).replace(":", "");
    const safe = `${meta.date}-${stamp}-${String(meta.subject).replace(/[^\p{L}\p{N} .-]/gu, "").trim().slice(0, 60) || "вебинар"}.pdf`.replace(/[/\\]/g, "-");
    const file = path.join(dir, safe);
    writeFileSync(file, body);
    const groups = Array.isArray(meta.groups) ? meta.groups.map(String) : [];
    const deckId = deps.repo.addSlideDeck({
      date: String(meta.date),
      subject: String(meta.subject),
      teacher: meta.teacher ? String(meta.teacher) : null,
      title: meta.title ? String(meta.title) : null,
      groups,
      slides: Number(meta.slides ?? 0),
      file,
      bytes: body.length,
    });
    logger.info({ deckId, subject: meta.subject, slides: meta.slides, bytes: body.length }, "получены слайды вебинара");
    deps.onSlides?.({ date: String(meta.date), subject: String(meta.subject), teacher: meta.teacher ? String(meta.teacher) : null, title: meta.title ? String(meta.title) : null, groups, slides: Number(meta.slides ?? 0), file, bytes: body.length, deckId });
    return { status: 200, text: "ok" };
  };

  /** Убрать брошенные загрузки (записывалка упала посреди отправки и начала заново). */
  const sweepParts = (): void => {
    const root = path.join(slidesDir(), ".parts");
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name);
      try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_PARTS_MS) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* уже удалили */
      }
    }
  };

  const handleSlides = async (req: IncomingMessage, res: ServerResponse, kind: "whole" | "part" | "complete"): Promise<void> => {
    const reply = (status: number, text: string): void => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(text);
    };
    const token = deps.slidesToken;
    const auth = req.headers.authorization ?? "";
    if (!token || !sameSecret(auth, `Bearer ${token}`)) return reply(token ? 403 : 404, "нет доступа");
    try {
      if (kind === "whole") {
        const body = await readBody(req, MAX_DECK_BYTES);
        const r = acceptDeck(req.headers["x-slides-meta"], body);
        return reply(r.status, r.text);
      }
      const id = String(req.headers["x-upload-id"] ?? "");
      if (!UPLOAD_ID.test(id)) return reply(400, "X-Upload-Id: 16–64 шестнадцатеричных символа");
      if (kind === "part") {
        const index = Number(req.headers["x-part-index"]);
        if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS) return reply(400, `X-Part-Index: целое от 0 до ${MAX_PARTS - 1}`);
        const body = await readBody(req, MAX_PART_BYTES);
        if (!body.length) return reply(400, "пустой кусок");
        sweepParts();
        mkdirSync(partsDir(id), { recursive: true });
        writeFileSync(path.join(partsDir(id), `${index}.part`), body);
        return reply(200, "ok");
      }
      // complete: собрать по порядку, сверить размер и сумму, принять как целый PDF.
      const count = Number(req.headers["x-part-count"]);
      const sha = String(req.headers["x-sha256"] ?? "").toLowerCase();
      if (!Number.isInteger(count) || count < 1 || count > MAX_PARTS) return reply(400, `X-Part-Count: целое от 1 до ${MAX_PARTS}`);
      if (!/^[a-f0-9]{64}$/.test(sha)) return reply(400, "X-Sha256: 64 шестнадцатеричных символа");
      const chunks: Buffer[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const part = path.join(partsDir(id), `${i}.part`);
        // Кусок не дошёл — записывалка перешлёт всё заново.
        if (!existsSync(part)) return reply(409, `нет куска ${i}`);
        const buf = readFileSync(part);
        total += buf.length;
        if (total > MAX_DECK_BYTES) {
          rmSync(partsDir(id), { recursive: true, force: true });
          return reply(413, "слишком большой PDF");
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);
      rmSync(partsDir(id), { recursive: true, force: true });
      if (createHash("sha256").update(body).digest("hex") !== sha) return reply(422, "контрольная сумма не сошлась");
      const r = acceptDeck(req.headers["x-slides-meta"], body);
      return reply(r.status, r.text);
    } catch (err) {
      logger.warn({ err: String(err) }, "не смог принять слайды");
      reply(String(err).includes("too large") ? 413 : 400, "не принял");
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // Порт открыт всему интернету: «GET //[» или «GET http://a:b/» Node пропускает,
    // а new URL на них бросает — без этой проверки один такой запрос ронял весь бот.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("bad request");
      return;
    }
    const method = req.method ?? "GET";
    // Слайды вебинаров приходят POST-ом от записывалки на отдельном сервере.
    if (method === "POST" && (url.pathname === "/slides" || url.pathname === "/slides/part" || url.pathname === "/slides/complete")) {
      void handleSlides(req, res, url.pathname === "/slides/part" ? "part" : url.pathname === "/slides/complete" ? "complete" : "whole");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const send = (status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
      // A feed is personal: never let a shared proxy cache it.
      res.writeHead(status, { "Content-Type": type, "Content-Length": String(buf.length), "Cache-Control": status === 200 ? "private, max-age=300" : "no-store", ...extra });
      res.end(method === "HEAD" ? undefined : buf);
    };
    if (url.pathname === "/health") {
      const p = deps.repo.lastPollRun();
      // Слайды: сколько записей принято и когда последняя — чтобы после
      // вебинара было видно снаружи, дошёл ли PDF от записывалки.
      const last = deps.repo.recentSlideDecks(1)[0];
      const slides = deps.slidesToken ? { decks: deps.repo.slideDeckCount(), last: last ? { date: last.date, subject: last.subject, slides: last.slides, receivedAt: last.createdAt } : null } : null;
      send(200, JSON.stringify({ ok: true, lastPoll: p?.finishedAt ?? null, groups: deps.service.groups().length, slides }), "application/json; charset=utf-8", { "Cache-Control": "no-store" });
      return;
    }
    const m = /^\/cal\/([A-Za-z0-9_-]{8,64})\.ics$/.exec(url.pathname);
    if (m) {
      try {
        const r = feed(m[1]!);
        send(r.status, r.body, r.type, r.status === 200 ? { "Content-Disposition": 'inline; filename="vish.ics"' } : {});
      } catch (err) {
        logger.warn({ err: String(err) }, "calendar feed failed");
        send(500, "feed error", "text/plain; charset=utf-8");
      }
      return;
    }
    send(404, "vish-bot", "text/plain; charset=utf-8");
  };

  const server = createServer((req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      // Любая неожиданная ошибка запроса — ответ 500, а не падение процесса.
      logger.warn({ err: String(err) }, "http request failed");
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("error");
    }
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  // The bot only offers subscription links while the server is actually listening,
  // so a busy port degrades to "file only" instead of handing out dead links.
  server.on("error", (err) => logger.error({ err: String(err), port: deps.port }, "http server error (calendar subscriptions are off)"));
  try {
    server.listen(deps.port, deps.host ?? "0.0.0.0", () => logger.info({ port: deps.port }, "http server listening (calendar feeds, /health)"));
  } catch (err) {
    // An out-of-range port throws right here; the bot must still start.
    logger.error({ err: String(err), port: deps.port }, "http server could not listen (calendar subscriptions are off)");
  }
  return server;
}
