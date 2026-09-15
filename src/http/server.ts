/**
 * Tiny HTTP server: personal calendar feeds (webcal subscriptions) and a
 * health probe. Plain HTTP is enough: iOS/macOS Calendar and Google Calendar
 * subscribe to http:// feeds, so the hosting's open port and domain suffice.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Repo } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import { groupCalendar } from "../schedule/calendar.js";
import { logger } from "../logger.js";

export interface HttpDeps {
  repo: Repo;
  service: ScheduleService;
  port: number;
  host?: string;
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

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
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
      send(200, JSON.stringify({ ok: true, lastPoll: p?.finishedAt ?? null, groups: deps.service.groups().length }), "application/json; charset=utf-8", { "Cache-Control": "no-store" });
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

  const server = createServer(handler);
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
