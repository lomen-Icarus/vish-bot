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
const MAX_CACHE_ENTRIES = 500;

export function calendarPath(token: string): string {
  return `/cal/${token}.ics`;
}

export function createHttpServer(deps: HttpDeps): Server {
  const cache = new Map<string, { at: number; body: string }>();

  const feed = (token: string): { status: number; body: string; type: string } => {
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < FEED_CACHE_MS) return { status: 200, body: hit.body, type: "text/calendar; charset=utf-8" };
    const user = deps.repo.userByCalToken(token);
    if (!user || user.blocked) return { status: 404, body: "not found", type: "text/plain; charset=utf-8" };
    const group = user.groupKey ? deps.service.group(user.groupKey) : null;
    if (!group) return { status: 404, body: "group not chosen", type: "text/plain; charset=utf-8" };
    const { ics } = groupCalendar(deps.service, group, { subgroup: user.subgroup, alarmMinutes: user.calAlarmMin, refreshInterval: "PT1H" });
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(token, { at: Date.now(), body: ics });
    return { status: 200, body: ics, type: "text/calendar; charset=utf-8" };
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const send = (status: number, body: string, type: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)), "Cache-Control": status === 200 ? "public, max-age=300" : "no-store", ...extra });
      res.end(method === "HEAD" ? undefined : body);
    };
    if (url.pathname === "/health") {
      const p = deps.repo.lastPollRun();
      send(200, JSON.stringify({ ok: true, lastPoll: p?.finishedAt ?? null, groups: deps.service.groups().length }), "application/json; charset=utf-8");
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
  server.on("error", (err) => logger.error({ err }, "http server error"));
  server.listen(deps.port, deps.host ?? "0.0.0.0", () => logger.info({ port: deps.port }, "http server listening (calendar feeds, /health)"));
  return server;
}
